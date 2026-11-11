/**
 * Patch schemas: a command that updates a few fields of a stored object must not parse the fields
 * it was not given. `schema.partial()` is not enough under zod 4: a field with a `.default()` still
 * gets its default when absent, so a patch of one setting would reset all the others.
 *
 * Handled: a default (or prefault) at the top of a field, under `.optional()`, `.nullable()` or
 * `.readonly()`, and under a transform (`.default().transform()`, which still runs on a given value).
 * Not handled, so not to be used on such a schema without extending this: a `.refine()` or a
 * `.describe()` placed after the default (they are dropped with it), a default under `z.lazy()` or
 * in a branch of a `z.union()`, and the defaults of a nested object (applied when it is given).
 * test/core-zod-patch.test.ts checks that the schemas patched today produce nothing for an empty patch.
 */
import { z } from "zod";

/** The type without its default, wherever the default sits among the wrappers listed above. */
function withoutDefault(type: z.ZodType): z.ZodType {
  if (type instanceof z.ZodDefault || type instanceof z.ZodPrefault) return withoutDefault(type.unwrap() as z.ZodType);
  if (type instanceof z.ZodOptional) return withoutDefault(type.unwrap() as z.ZodType).optional();
  if (type instanceof z.ZodNullable) return withoutDefault(type.unwrap() as z.ZodType).nullable();
  if (type instanceof z.ZodReadonly) return withoutDefault(type.unwrap() as z.ZodType).readonly();
  if (type instanceof z.ZodPipe) return z.pipe(withoutDefault(type.in as z.ZodType), type.out as z.ZodType) as unknown as z.ZodType;
  return type;
}

/** Every field of `schema` optional and without its default: what is absent stays absent in the parsed patch. */
export function patchSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<{ [K in keyof T]: z.ZodOptional<z.ZodType<z.output<T[K]>, z.input<T[K]>>> }> {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, type]) => [key, withoutDefault(type as z.ZodType).optional()]));
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof T]: z.ZodOptional<z.ZodType<z.output<T[K]>, z.input<T[K]>>> }>;
}
