/**
 * `kosong/contract` domain — the provider-agnostic tool definition.
 *
 * A tool that the model may invoke during generation. The definition is
 * provider-agnostic; each provider implementation converts it to the
 * appropriate wire format (e.g. OpenAI function-calling, Anthropic tool-use,
 * Google function declarations).
 * Text input tools retain a JSON schema with an `input` string for runtimes
 * and providers using function calls; supporting wires may expose raw text.
 */

export interface ToolInputFormat {
  readonly type: 'text';
  readonly grammar?: {
    readonly syntax: 'lark';
    readonly definition: string;
  };
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  inputFormat?: ToolInputFormat;
  deferred?: true;
}
