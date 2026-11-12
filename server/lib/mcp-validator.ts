// The JSON-schema validator every host-side MCP Client shares.
//
// The SDK's default (one Ajv per Client) compiles every tool's outputSchema on
// EVERY listTools() and Ajv keeps each compiled schema forever, keyed by the
// schema OBJECT — and each listTools returns fresh objects. A long-lived gateway
// client re-listing a vendor with big output schemas (Sentry: ~64 of them) leaked
// ~3.6 MB and ~250 ms of CPU per list, which is how the host reached 8+ GB.
//
// Here a schema is compiled once per distinct CONTENT, and the cache is bounded:
// past CAP distinct schemas the whole Ajv generation is dropped and rebuilt.
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { jsonSchemaValidator, JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';

export const CAP = 1000;

let ajv = new AjvJsonSchemaValidator();
const memo = new Map<string, JsonSchemaValidator<unknown>>();

export const sharedValidator: jsonSchemaValidator = {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const key = JSON.stringify(schema);
    let v = memo.get(key);
    if (!v) {
      if (memo.size >= CAP) {
        memo.clear();
        ajv = new AjvJsonSchemaValidator();
      }
      v = ajv.getValidator<unknown>(schema);
      memo.set(key, v);
    }
    return v as JsonSchemaValidator<T>;
  },
};

/** Options for `new Client(info, mcpClientOptions())` — every host-side client uses the shared validator. */
export const mcpClientOptions = () => ({ capabilities: {}, jsonSchemaValidator: sharedValidator });

/** How many distinct schemas are compiled right now (tests, health log). */
export const compiledSchemas = () => memo.size;
