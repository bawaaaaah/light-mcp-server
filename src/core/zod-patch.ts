/**
 * Patch schemas: a command that updates a few fields of a stored object must not parse the fields
 * it was not given. `schema.partial()` is not enough under zod 4: a field with a `.default()` still
 * gets its default when absent, so a patch of one setting would reset all the others.
 */
import { z } from "zod";

/** The type without its default (also under a transform: the transform still runs on a given value). */
function withoutDefault(type: z.ZodType): z.ZodType {
  if (type instanceof z.ZodDefault) return withoutDefault(type.unwrap() as z.ZodType);
  if (type instanceof z.ZodPipe) return z.pipe(withoutDefault(type.in as z.ZodType), type.out as z.ZodType) as unknown as z.ZodType;
  return type;
}

/** Every field of `schema` optional and without its default: what is absent stays absent in the parsed patch. */
export function patchSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<{ [K in keyof T]: z.ZodOptional<z.ZodType<z.output<T[K]>, z.input<T[K]>>> }> {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, type]) => [key, withoutDefault(type as z.ZodType).optional()]));
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof T]: z.ZodOptional<z.ZodType<z.output<T[K]>, z.input<T[K]>>> }>;
}
