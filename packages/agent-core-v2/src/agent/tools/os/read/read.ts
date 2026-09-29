/**
 * `tools` domain — `IReadTool` contract.
 *
 * Public contract of Read, the model's UTF-8 text file reader. Renders a
 * text file as `<line-number>\t<content>` per line as `output`, and rides a
 * `<system>…</system>` status block on the `note` side channel (rendered to
 * the model at projection time, never to UIs) summarizing how much was read
 * (character counts, truncation, continuation arguments, and line-ending
 * notes). Pure CRLF files are displayed with LF line endings; mixed or lone
 * carriage returns are shown as `\r` so the model can reproduce them exactly.
 *
 * Pages are bounded by a character budget rather than a line cap: `max_chars`
 * defaults to `DEFAULT_MAX_CHARS` and is capped at `DEFAULT_MAX_CHARS_LIMIT`,
 * and a truncated page carries the `Next Read` arguments (`line_offset`,
 * `column_offset`, `n_lines`, `max_chars`) that resume it — including
 * mid-line continuation for a line longer than the budget.
 *
 * UTF-16 LE/BE text files (with a BOM, or recognized via the zero-byte
 * parity heuristic) are transparently transcoded to UTF-8 for display, up to
 * `TRANSCODE_MAX_BYTES`. Binary, other non-UTF encodings, NUL-containing,
 * image and video files are refused; images/videos are redirected to
 * ReadMediaFile. Supports one-based `line_offset` / `n_lines` pagination and
 * a negative `line_offset` tail mode.
 *
 * Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const DEFAULT_MAX_CHARS: number = 100_000;
export const DEFAULT_MAX_CHARS_LIMIT: number = 500_000;

/**
 * Largest file the Read tool transcodes from UTF-16 in memory. Unlike the
 * streaming UTF-8 path, transcoding needs the whole file decoded at once;
 * 10 MiB mirrors kap-server's `FS_READ_MAX_BYTES`.
 */
export const TRANSCODE_MAX_BYTES: number = 10 * 1024 * 1024;

const PositiveLineOffsetSchema = z.number().int().min(1);
const TailLineOffsetSchema = z.number().int().negative();

export const ReadInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to a text file, a builtin:// skill resource, or a kimi-file:// attachment reference in the current session. Relative filesystem paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use `ls` via Bash for a known directory, or Glob for pattern search.',
    ),
  line_offset: z
    .union([PositiveLineOffsetSchema, TailLineOffsetSchema])
    .optional()
    .describe(
      'The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file (for example, -100 reads the last 100 lines).',
    ),
  column_offset: z.number().int().nonnegative().optional().describe(
    'Zero-based character offset within the first line of a forward read, excluding its line-number prefix. Uses JavaScript string length in the displayed text. Copy continuation arguments from the previous result to resume a long line.',
  ),
  n_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'The number of lines to read. Omit to read toward the end of the file. Results are bounded by max_chars, with continuation arguments when the requested range is incomplete.',
    ),
  max_chars: z.number().int().positive().optional().describe(
    'Maximum characters in the returned text, including line numbers and status. Omit for the configured default; requests above the configured maximum are capped.',
  ),
});

export const ReadOutputSchema = z.object({
  content: z.string(),
  lineCount: z.number().int().nonnegative(),
});

export type ReadInput = z.infer<typeof ReadInputSchema>;
export type ReadOutput = z.infer<typeof ReadOutputSchema>;

export interface IReadTool extends AgentTool<ReadInput> { readonly _serviceBrand: undefined }
export const IReadTool = createDecorator<IReadTool>('readTool');
