import { z } from 'zod';

/**
 * LLM-facing tool schemas for the customer domain (constitution Principle IV).
 *
 * These are the ONLY shapes an agent sees. No CRS, QBS, or metrics DTO field name may
 * appear here — `configSource`, `contextId`, `hierarchyGroups`, `gpEligibility`,
 * `birDelay`, `gmltl`, `riskInfo`, `wageInfo`, `entityIds`, `numberOfLines`,
 * `betNotesDetails`, `EVENTTYPE`, `vipManager` — every one of them is translated at
 * the client boundary, exactly as `configSource → instance` already is in the
 * catalogue domain.
 *
 * `test/unit/architecture.test.ts` asserts that upstream vocabulary is absent from
 * this file, so the boundary is enforced rather than merely intended.
 */

/**
 * The completeness verdict, present on EVERY successful tool result (FR-005).
 *
 * BOTH axes are present, always, and are never merged (constitution Principle II).
 * The `.describe()` text is where that distinction becomes behaviour: each axis tells
 * the agent what to DO, and the two instructions are deliberately opposite about
 * retrying. An agent told "a section is missing" the way it is told "an instance
 * failed" retries with narrower scoping, which cannot fix a missing section — so it
 * retries indefinitely.
 */
export const completenessSchema = z
  .object({
    complete: z
      .boolean()
      .describe(
        'True only when every source answered AND no section of the answer is missing. When false, the data is incomplete and you MUST relay the caveat to the user.'
      ),
    outcome: z
      .enum(['COMPLETE', 'PARTIAL', 'TOO_BROAD', 'TIMEOUT_PARTIAL'])
      .describe('The most severe outcome encountered across every step taken.'),
    successfulInstances: z.array(z.string()).describe('Sources that answered.'),
    failedInstances: z
      .array(z.string())
      .describe(
        'Sources that did not answer, so this list may be missing ROWS. Name these to the user when non-empty; a narrowed retry may help.'
      ),
    unavailableComponents: z
      .array(
        z.enum([
          'customerRiskConfiguration',
          'betDetail',
          'legCataloguePositions',
          'jurisdictionContexts'
        ])
      )
      .describe(
        'Sections of THIS answer that could not be retrieved, even though every source consulted answered. State what is absent; retrying with different scoping will NOT help.'
      ),
    errors: z
      .array(
        z.object({
          instance: z.string(),
          message: z.string()
        })
      )
      .describe('What each failing source reported.'),
    caveat: z
      .string()
      .nullable()
      .describe(
        'A sentence to relay to the user verbatim when the result is incomplete; null when it is complete.'
      )
  })
  .describe(
    'Data-completeness verdict with two independent axes. Always present, including on full success. Never present partial data as if it were complete.'
  );

/**
 * A jurisdiction a customer capability can be scoped to (data-model.md section 3).
 *
 * Shaped deliberately like the catalogue domain's `brandInstanceSchema` —
 * `{ code, id, name }` — so the two discovery tools read the same way to a model even
 * though their vocabularies are unrelated.
 */
export const jurisdictionRefSchema = z
  .object({
    code: z
      .string()
      .describe(
        'Short code, e.g. "NJ". This is what the metrics jurisdiction filter takes. NOT always two letters — do not derive it from a state name.'
      ),
    id: z.string().describe('Opaque identifier for this jurisdiction.'),
    name: z.string().describe('Human-readable jurisdiction name, e.g. "New Jersey".')
  })
  .describe('One jurisdiction that customer risk settings and betting metrics belong to.');

export type JurisdictionRef = z.infer<typeof jurisdictionRefSchema>;

/** Output of `list_jurisdiction_contexts`. It takes no input at all. */
export const listJurisdictionContextsOutputSchema = {
  jurisdictions: z
    .array(jurisdictionRefSchema)
    .describe(
      'Every jurisdiction customer risk settings and betting metrics can be scoped to. Use the "code" values as the jurisdictions filter.'
    ),
  completeness: completenessSchema
};
