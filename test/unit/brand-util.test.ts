import { describe, expect, it } from 'vitest';
import { shiftSubtitleText } from '@main/pipeline/brand-util';

describe('shiftSubtitleText', () => {
  it('shifts SRT cues and keeps the comma separator', () => {
    const srt = '1\n00:00:01,500 --> 00:00:03,250\nHello\n\n2\n00:59:59,900 --> 01:00:00,100\nWorld\n';
    expect(shiftSubtitleText(srt, 2.5)).toBe(
      '1\n00:00:04,000 --> 00:00:05,750\nHello\n\n2\n01:00:02,400 --> 01:00:02,600\nWorld\n',
    );
  });
  it('shifts WebVTT cues and keeps the dot separator and the header', () => {
    const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n';
    expect(shiftSubtitleText(vtt, 1.25)).toBe('WEBVTT\n\n00:00:01.250 --> 00:00:02.250\nHi\n');
  });
  it('is the identity for a zero shift and never goes negative', () => {
    const s = '1\n00:00:00,100 --> 00:00:01,000\nx\n';
    expect(shiftSubtitleText(s, 0)).toBe(s);
    expect(shiftSubtitleText(s, -5)).toBe('1\n00:00:00,000 --> 00:00:00,000\nx\n');
  });
  it('does not touch text that merely looks like a number', () => {
    expect(shiftSubtitleText('1\n00:00:01,000 --> 00:00:02,000\nAt 12:30:45 sharp\n', 1)).toContain(
      'At 12:30:45 sharp',
    );
  });
});
