import type { Plugin } from "@opencode/plugin";
import { compressOutput } from "./compress.ts";
import { minifyJson } from "./json.ts";

type CompressionInput = {
  readonly text: string;
  readonly command?: string;
  readonly exitCode?: number;
};

export async function registerCodeModeTools(ctx: Plugin.Context): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.namespace({ name: "rtk", description: "Compact captured output without executing commands" });
    editor.add({
      name: "compress",
      description:
        "Compact already-captured text for final display, without executing the command. " +
        "A command hint requires exitCode: 0 for RTK filtering; failed or unknown exits stay raw. " +
        "Without a command, only complete JSON is losslessly minified. Keep original data for script logic.",
      input: {
        type: "object",
        properties: {
          text: { type: "string" },
          command: { type: "string", description: "Filter hint only; never executed" },
          exitCode: { type: "integer", description: "Captured command exit code; 0 enables filtering" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          text: { type: "string" },
          inputBytes: { type: "integer", minimum: 0 },
          outputBytes: { type: "integer", minimum: 0 },
          savedBytes: { type: "integer", minimum: 0 },
        },
        required: ["text", "inputBytes", "outputBytes", "savedBytes"],
        additionalProperties: false,
      },
      options: { namespace: "rtk", codemode: true },
      execute: async (input) => {
        const args = input as CompressionInput;
        const original = args.text;
        let text = original;
        try {
          if (process.env.RTK_DISABLED !== "1" && (args.exitCode === undefined || args.exitCode === 0)) {
            if (args.command) {
              // Unknown command status is not permission to prune its diagnostics.
              if (args.exitCode === 0) {
                text = await compressOutput(args.command, original, ctx.location.directory);
              }
            } else {
              text = minifyJson(original);
            }
          }
        } catch {
          // Filtering is optional; a helper failure must retain the captured text.
          text = original;
        }
        const inputBytes = Buffer.byteLength(original);
        const outputBytes = Buffer.byteLength(text);
        const output = { text, inputBytes, outputBytes, savedBytes: inputBytes - outputBytes };
        return { output, content: text };
      },
    });
  });
}
