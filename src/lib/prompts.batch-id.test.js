import { describe, it, expect } from 'vitest';
import { buildBatchClassificationPrompt } from './prompts';

describe('buildBatchClassificationPrompt - id echo instruction (item C)', () => {
  it('includes an "id" field in the output schema example', () => {
    const prompt = buildBatchClassificationPrompt([{ id: 'b1', title: 'Dune' }]);
    expect(prompt).toMatch(/"id":\s*"[^"]*"/);
  });

  it('instructs the model to echo the book id verbatim', () => {
    const prompt = buildBatchClassificationPrompt([{ id: 'b1', title: 'Dune' }]);
    expect(prompt).toMatch(/echo(es)? the book'?s? id verbatim/i);
  });

  it('still lists each book with its id in the per-book context header', () => {
    const prompt = buildBatchClassificationPrompt([{ id: 'b1', title: 'Dune' }]);
    expect(prompt).toContain('(id: b1)');
  });
});
