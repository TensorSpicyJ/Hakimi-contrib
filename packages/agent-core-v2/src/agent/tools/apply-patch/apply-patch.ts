/**
 * `applyPatch` domain — the Agent-scoped patch tool contract.
 *
 * Owns the JSON fallback input schema and grammar for the optional Responses
 * freeform input; both formats carry the same patch text into the tool.
 */

import { z } from 'zod';
import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const APPLY_PATCH_TOOL_NAME = 'apply_patch';
export const ApplyPatchInputSchema = z.object({
  input: z.string().min(1).describe('The complete patch, beginning with *** Begin Patch and ending with *** End Patch.'),
});
export type ApplyPatchInput = z.infer<typeof ApplyPatchInputSchema>;

export interface IApplyPatchTool extends AgentTool<ApplyPatchInput> {
  readonly _serviceBrand: undefined;
}

export const IApplyPatchTool = createDecorator<IApplyPatchTool>('applyPatchTool');

export const APPLY_PATCH_GRAMMAR = String.raw`start: "*** Begin Patch" LF file+ "*** End Patch" LF?
file: add_file | update_file | delete_file
add_file: "*** Add File: " TEXT LF added_line*
delete_file: "*** Delete File: " TEXT LF
update_file: "*** Update File: " TEXT LF update_line+ end_of_file?
update_line: hunk_header | context_line | added_line | removed_line
hunk_header: "@@" (" " TEXT)? LF
context_line: " " TEXT? LF
added_line: "+" TEXT? LF
removed_line: "-" TEXT? LF
end_of_file: "*** End of File" LF
TEXT: /[^\r\n]+/
LF: "\n"
`;
