import { ApiError, FinishReason, GenerateContentResponse, BlockedReason, type GenerateContentParameters } from '@google/genai';
import { describe, expect, it } from 'vitest';

import { createGeminiVisionExtractor, interpretResponse, type VisionUsageRecord } from './vision';

const IMAGE = { mediaType: 'image/jpeg' as const, data: '/9j/4A==' };

/** A response as the SDK would build it: its `text` getter reads the first candidate's parts. */
function reply(fields: Partial<GenerateContentResponse>): GenerateContentResponse {
  return Object.assign(new GenerateContentResponse(), fields);
}

function answered(body: unknown, finishReason: FinishReason = FinishReason.STOP): GenerateContentResponse {
  return reply({
    candidates: [{ content: { role: 'model', parts: [{ text: typeof body === 'string' ? body : JSON.stringify(body) }] }, finishReason }],
    usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 80, thoughtsTokenCount: 30 },
    modelVersion: 'gemini-test-001',
  });
}

describe('Gemini label reader', () => {
  it('sends the image with the JSON schema and maps empty fields to null', async () => {
    const sent: GenerateContentParameters[] = [];
    const logged: VisionUsageRecord[] = [];
    const extract = createGeminiVisionExtractor({
      apiKey: 'unused',
      model: 'gemini-test',
      log: (record) => logged.push(record),
      generateContent: (params) => {
        sent.push(params);
        return Promise.resolve(
          answered({ labels: [{ brand: 'Citadel', name: 'Mephiston Red', code: '' }, { brand: ' ', name: 'Nuln Oil', code: '' }] }),
        );
      },
    });

    expect(await extract(IMAGE)).toEqual({
      kind: 'labels',
      labels: [
        { brand: 'Citadel', name: 'Mephiston Red', code: null },
        { brand: null, name: 'Nuln Oil', code: null },
      ],
    });
    const request = sent[0];
    expect(request?.model).toBe('gemini-test');
    expect(request?.config?.responseMimeType).toBe('application/json');
    expect(request?.config?.responseJsonSchema).toBeDefined();
    expect(JSON.stringify(request?.contents)).toContain('"inlineData":{"mimeType":"image/jpeg","data":"/9j/4A=="}');
    // Usage is logged without any label text or image data.
    expect(logged).toEqual([
      expect.objectContaining({
        outcome: 'labels',
        model: 'gemini-test-001',
        inputTokens: 1200,
        outputTokens: 80,
        thinkingTokens: 30,
        labelCount: 2,
        stopReason: 'STOP',
      }),
    ]);
    expect(JSON.stringify(logged)).not.toContain('Mephiston');
  });

  it('reports a blocked prompt or a declined answer as a refusal', () => {
    expect(interpretResponse(reply({ promptFeedback: { blockReason: BlockedReason.SAFETY } }))).toEqual({ kind: 'refused' });
    expect(interpretResponse(answered('', FinishReason.SAFETY))).toEqual({ kind: 'refused' });
    expect(interpretResponse(answered('', FinishReason.PROHIBITED_CONTENT))).toEqual({ kind: 'refused' });
  });

  it('reports a cut-off, malformed or empty answer as unreadable', () => {
    expect(interpretResponse(answered('{"labels":[{"brand":"Cit', FinishReason.MAX_TOKENS))).toEqual({ kind: 'unreadable' });
    expect(interpretResponse(answered('not json'))).toEqual({ kind: 'unreadable' });
    expect(interpretResponse(answered({ labels: 'nope' }))).toEqual({ kind: 'unreadable' });
    expect(interpretResponse(answered({ labels: [{ brand: 5 }] }))).toEqual({ kind: 'unreadable' });
    expect(interpretResponse(reply({ candidates: [] }))).toEqual({ kind: 'unreadable' });
    expect(interpretResponse(answered({ labels: [] }))).toEqual({ kind: 'labels', labels: [] });
  });

  it('logs and rethrows an API error, so the endpoint can answer 502', async () => {
    const logged: VisionUsageRecord[] = [];
    const extract = createGeminiVisionExtractor({
      apiKey: 'unused',
      log: (record) => logged.push(record),
      generateContent: () => Promise.reject(new ApiError({ message: 'quota', status: 429 })),
    });
    await expect(extract(IMAGE)).rejects.toBeInstanceOf(ApiError);
    expect(logged).toEqual([expect.objectContaining({ outcome: 'error', status: 429 })]);
  });
});
