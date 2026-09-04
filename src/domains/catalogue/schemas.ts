import { z } from 'zod';

/**
 * LLM-facing tool schemas (constitution Principle IV).
 *
 * These are the ONLY shapes an agent sees. GMA DTO field names, HTTP mechanics, and
 * envelope internals must never appear here — in particular `configSource`,
 * `successfulConfigSources`, and `instancesList`, which are translated at the client
 * boundary in `core/completeness.ts` and `core/instances.ts`.
 *
 * A test asserts that upstream vocabulary is absent from every schema in this file,
 * so the boundary is enforced rather than merely intended.
 */

/** The completeness verdict, present on EVERY successful tool result (FR-005). */
export const completenessSchema = z
  .object({
    complete: z
      .boolean()
      .describe(
        'True only when every brand instance answered. When false, the data is incomplete and you MUST relay the caveat to the user.'
      ),
    outcome: z
      .enum(['COMPLETE', 'PARTIAL', 'TOO_BROAD', 'TIMEOUT_PARTIAL'])
      .describe('The most severe outcome encountered across every step taken.'),
    successfulInstances: z.array(z.string()).describe('Brand instances that answered.'),
    failedInstances: z
      .array(z.string())
      .describe('Brand instances that did not answer. Name these to the user when non-empty.'),
    errors: z
      .array(
        z.object({
          instance: z.string(),
          message: z.string()
        })
      )
      .describe('What each failing instance reported.'),
    caveat: z
      .string()
      .nullable()
      .describe(
        'A sentence to relay to the user verbatim when the result is incomplete; null when it is complete.'
      )
  })
  .describe(
    'Data-completeness verdict. Always present, including on full success. Never present partial data as if it were complete.'
  );

/** A brand instance a catalogue query can be scoped to (data-model.md section 3). */
export const brandInstanceSchema = z
  .object({
    code: z.string().describe('Short code, e.g. "PP". This is what a person says.'),
    id: z.string().describe('Opaque identifier. Pass either this or the code back as an instance.'),
    name: z.string().describe('Human-readable brand name, e.g. "PaddyPower".')
  })
  .describe('One brand instance that catalogue queries can be narrowed to.');

/** Output of `list_instances`. */
export const listInstancesOutputSchema = {
  instances: z
    .array(brandInstanceSchema)
    .describe('The brand instances that catalogue queries can be scoped to.'),
  completeness: completenessSchema
};

/** The three catalogue entity types this slice supports. */
export const entityTypeSchema = z
  .enum(['superclass', 'subclass', 'eventType'])
  .describe(
    'Catalogue level: a superclass contains subclasses, which contain event types. "superclass" is the broadest.'
  );

/** An ancestor in an entity's path — the detail that distinguishes same-named entities. */
export const ancestorSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: entityTypeSchema
});

/** A catalogue entity (data-model.md section 2). */
export const catalogueEntitySchema = z
  .object({
    id: z.string().describe('Opaque identifier. Pass this to get_catalogue_entity.'),
    name: z.string(),
    type: entityTypeSchema,
    ancestors: z
      .array(ancestorSchema)
      .describe(
        'Path from broadest to nearest parent; empty for a superclass. This is how two entities with the same name are told apart — always show it when presenting candidates.'
      )
  })
  .describe('A named node in the catalogue hierarchy.');

/**
 * The optional per-tool instance override (FR-017).
 *
 * Note what is NOT here: no base URL, no timeout, no issuer. Operational values come
 * from deployment configuration only (FR-018, Principle V).
 */
export const instancesInputSchema = z
  .array(z.string().min(1))
  .min(1)
  .optional()
  .describe(
    'Optional brand instances to narrow to, as codes (e.g. ["PP"]) or ids. Omit to use this deployment\'s configured default set — you do not need to know what it is. Call list_instances for valid codes.'
  );

/** Input of `find_catalogue_entity`. */
export const findCatalogueEntityInputSchema = {
  name: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, {
      message: 'name must not be blank'
    })
    .describe('Partial, case-insensitive name to search for, e.g. "Premier League".'),
  instances: instancesInputSchema
};

/** Output of `find_catalogue_entity` — a discriminated union on `kind` (FR-014). */
export const findCatalogueEntityOutputSchema = {
  kind: z
    .enum(['resolved', 'candidates', 'none', 'tooBroad'])
    .describe(
      'resolved: exactly one match, returned with its immediate children. candidates: several matched and NONE was chosen — present them all to the user and ask which they mean. none: nothing matched (this is not an error). tooBroad: too many matched to be useful.'
    ),
  entity: catalogueEntitySchema.optional().describe('Present only when kind is "resolved".'),
  children: z
    .array(catalogueEntitySchema)
    .optional()
    .describe('The resolved entity\'s immediate children. Present only when kind is "resolved".'),
  candidates: z
    .array(catalogueEntitySchema)
    .optional()
    .describe(
      'Every entity that matched. Present only when kind is "candidates". Do not pick one yourself.'
    ),
  matchCount: z
    .number()
    .optional()
    .describe('How many entities matched. Present when kind is "tooBroad".'),
  narrowBy: z
    .array(z.string())
    .optional()
    .describe('What to narrow the query by. Present only when kind is "tooBroad".'),
  completeness: completenessSchema
};

/** Input of `get_catalogue_entity`. */
export const getCatalogueEntityInputSchema = {
  type: entityTypeSchema.describe(
    'Which catalogue level the id refers to. Only these three are supported.'
  ),
  id: z.string().min(1).describe('The entity identifier, e.g. one taken from a candidate list.'),
  instances: instancesInputSchema
};

/** Output of `get_catalogue_entity`. */
export const getCatalogueEntityOutputSchema = {
  entity: catalogueEntitySchema,
  completeness: completenessSchema
};

export type BrandInstance = z.infer<typeof brandInstanceSchema>;
export type CatalogueEntity = z.infer<typeof catalogueEntitySchema>;
export type EntityType = z.infer<typeof entityTypeSchema>;
export type Ancestor = z.infer<typeof ancestorSchema>;
