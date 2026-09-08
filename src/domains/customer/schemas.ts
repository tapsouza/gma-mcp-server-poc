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

/** The four catalogue levels a risk override can apply to (data-model.md section 5). */
export const hierarchyLevelSchema = z
  .enum(['SUPERCLASS', 'SUBCLASS', 'EVENT_TYPE', 'MARKET_TYPE'])
  .describe(
    "Catalogue level a risk override applies to. SUPERCLASS is broadest; MARKET_TYPE is narrowest. NOTE: this is the RISK-side hierarchy, which is a different tree from a bet leg's sport/competition/event/market/selection."
  );

/**
 * A liability group, as a risk operator reads it (data-model.md section 4).
 *
 * `displayOrder` and `colour` are deliberately dropped: they are presentation
 * concerns for a UI, and a tool schema is for a model.
 */
export const liabilityGroupRefSchema = z
  .object({
    code: z.string().describe('Short code for the group, e.g. "LG3".'),
    description: z.string().describe('Human-readable name, e.g. "Managed Risk".'),
    interceptValue: z.number().describe("The group's intercept value.")
  })
  .describe('A liability group a customer or an override is assigned to.');

/** One node in a named catalogue path (data-model.md section 5). */
export const cataloguePathNodeSchema = z.object({
  level: hierarchyLevelSchema,
  id: z.string(),
  name: z.string()
});

/**
 * A risk setting applied to part of the catalogue rather than to a whole
 * configuration (data-model.md section 5).
 *
 * `path` is already resolved: GMA enriches every override with its full named
 * ancestor chain, so no catalogue lookup is needed to read one (FR-007, research.md
 * R3). An EMPTY path is possible and meaningful — it means the identifier matched
 * nothing in the catalogue — and is never filled with a fabricated name.
 */
export const hierarchyOverrideSchema = z
  .object({
    level: hierarchyLevelSchema,
    entityId: z.string().describe('Identifier of the catalogue entity this override applies to.'),
    path: z
      .array(cataloguePathNodeSchema)
      .describe(
        'The named catalogue path this override applies to, BROADEST FIRST — the same ordering as the catalogue tools\' "ancestors". Empty when the identifier matches nothing in the catalogue; that is a real state, not a lookup you should retry.'
      ),
    stakeFactor: z
      .number()
      .nullable()
      .describe('The stake factor this override applies. Null means unset, NOT zero.'),
    liabilityGroup: liabilityGroupRefSchema
      .nullable()
      .describe('The liability group this override applies; null when unset.')
  })
  .describe('A risk setting applied to one part of the catalogue.');

/**
 * A customer's risk settings WITHIN ONE JURISDICTION (data-model.md section 4).
 *
 * There is no global configuration. A customer holds several of these, and merging
 * them is prohibited (FR-006): a customer restricted on one sport in one state and
 * unrestricted in another must not be reported as either.
 *
 * Every scalar is nullable because the upstream types are boxed and any of them may
 * be absent. A missing value is `null`, NEVER `0` — an unset stake factor and a stake
 * factor of zero are different facts, and conflating them would report a customer as
 * blocked when they are merely unconfigured.
 */
export const customerRiskConfigurationSchema = z
  .object({
    jurisdiction: jurisdictionRefSchema.describe(
      'The jurisdiction these settings apply to. Never report settings from one jurisdiction as applying to another.'
    ),
    stakeFactor: z
      .number()
      .nullable()
      .describe('Stake factor for this jurisdiction. Null means unset, NOT zero.'),
    inRunningDelaySeconds: z
      .number()
      .nullable()
      .describe('Added delay on in-play bets, in seconds. Null means unset, NOT zero.'),
    liabilityGroup: liabilityGroupRefSchema.nullable(),
    eligibility: z
      .enum(['STANDARD', 'RESTRICTED', 'UNRESTRICTED'])
      .nullable()
      .describe('Eligibility profile for this jurisdiction; null when unset.'),
    payoutLimitSingles: z.number().nullable().describe('Payout limit for single bets.'),
    payoutLimitMultiples: z.number().nullable().describe('Payout limit for multiple bets.'),
    maxWinningsCap: z.number().nullable().describe('Cap on winnings.'),
    guaranteedMaxLimitToLose: z
      .boolean()
      .nullable()
      .describe('Whether a guaranteed maximum limit to lose applies.'),
    earlySettlementRestricted: z
      .boolean()
      .nullable()
      .describe('Whether early settlement is restricted.'),
    overrides: z
      .array(hierarchyOverrideSchema)
      .describe(
        'Risk settings applied to parts of the catalogue rather than to this whole configuration. An EMPTY list means no override exists for this jurisdiction — it does NOT mean the customer is unrestricted, because the jurisdiction-level settings above still apply.'
      )
  })
  .describe(
    "A customer's risk settings within ONE jurisdiction. A customer has one of these per jurisdiction they have settings in; there is no global configuration."
  );

/** Input of `get_customer_risk_profile`. */
export const getCustomerRiskProfileInputSchema = {
  accountId: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, {
      // No `message` echoing the value: zod puts the failing input in the issue, and
      // FR-030 forbids repeating an account identifier back anywhere.
      message: 'accountId must not be blank'
    })
    .describe('The customer account identifier.')
};

/** Output of `get_customer_risk_profile`. */
export const getCustomerRiskProfileOutputSchema = {
  accountId: z
    .string()
    .describe('Echoed back so you can correlate this result with your own request.'),
  jurisdictionConfigurations: z
    .array(customerRiskConfigurationSchema)
    .describe(
      'ONE configuration per jurisdiction the customer has settings in. NEVER summarise, average, or collapse across them: a customer may be restricted in one state and unrestricted in another, and either single summary would be wrong.'
    ),
  completeness: completenessSchema
};

export type HierarchyLevel = z.infer<typeof hierarchyLevelSchema>;
export type LiabilityGroupRef = z.infer<typeof liabilityGroupRefSchema>;
export type CataloguePathNode = z.infer<typeof cataloguePathNodeSchema>;
export type HierarchyOverride = z.infer<typeof hierarchyOverrideSchema>;
export type CustomerRiskConfiguration = z.infer<typeof customerRiskConfigurationSchema>;
