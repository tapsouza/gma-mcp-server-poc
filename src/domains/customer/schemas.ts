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
      .describe(
        'Eligibility profile for this jurisdiction; null when unset. "RESTRICTED" IS a restriction on this customer in this jurisdiction and you MUST report it when asked whether they are restricted — it is jurisdiction-wide, so it applies to every sport, including any sport with no entry in `overrides`. Never answer a question about restrictions from `overrides` alone without reading this field.'
      ),
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
        'Risk settings applied to parts of the catalogue rather than to this whole configuration. An EMPTY list means NO SPORT-SPECIFIC OVERRIDE EXISTS — it does NOT mean the customer is unrestricted, because the jurisdiction-level settings above still apply, `eligibility` in particular. So "no override for soccer" plus "eligibility: RESTRICTED" means the customer IS restricted on soccer, by the jurisdiction-wide setting. Answering "not restricted" from an empty list is a wrong answer about a real person\'s limits.'
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

/**
 * A named catalogue entity referenced by a bet leg (data-model.md section 6b).
 *
 * `id` comes from the leg's upstream identifier bag, and WHICH member supplied it is
 * an unverified assumption (research.md R9) — which is why the composite reports
 * `resolvedVia` in its result rather than leaving the guess invisible.
 */
export const namedEntitySchema = z.object({
  name: z.string(),
  id: z
    .string()
    .nullable()
    .describe('Identifier for this entity, or null when the bet carried no usable one.')
});

/**
 * One selection within a bet (data-model.md section 6b).
 *
 * NOTE what a leg does NOT carry: a risk-side catalogue level. `sport` / `competition`
 * / `event` / `market` / `selection` is a DIFFERENT TREE from the
 * `SUPERCLASS` / `SUBCLASS` / `EVENT_TYPE` / `MARKET_TYPE` levels risk overrides use
 * (research.md R5). Bridging them requires resolving the event, which is what
 * `get_bet_risk_context` exists to do — so do not attempt to match a leg to an
 * override yourself from this shape.
 */
export const betLegSchema = z
  .object({
    legNumber: z.number(),
    sport: namedEntitySchema,
    competition: namedEntitySchema,
    event: namedEntitySchema,
    market: namedEntitySchema.nullable(),
    selection: namedEntitySchema.nullable(),
    placedInPlay: z.boolean().nullable().describe('Whether the leg was placed while in play.'),
    price: z
      .object({ numerator: z.number(), denominator: z.number() })
      .nullable()
      .describe('The fractional price this leg was struck at.'),
    result: z
      .enum(['NONE', 'WIN', 'PLACE', 'LOSE', 'VOID'])
      .nullable()
      .describe('Outcome of this leg; null when not yet resulted.')
  })
  .describe(
    'One selection within a bet. Carries the catalogue entities it refers to, but NOT a risk-side catalogue level — those live in a different tree.'
  );

/**
 * The risk figures actually APPLIED to a bet (data-model.md section 6a).
 *
 * Bet-level, never per-leg. And their DERIVATION IS NOT AVAILABLE to this system
 * (FR-017): they are computed by GMA's downstream pricing and risk engine, whose
 * formula is not exposed. The schema deliberately carries no field that would let a
 * caller believe otherwise.
 */
export const appliedRiskFiguresSchema = z
  .object({
    stakeFactor: z.number().nullable(),
    liabilityGroup: z
      .string()
      .nullable()
      .describe(
        "The liability group applied, as a bare string. Whether this corresponds to a configured group's code or its description is NOT verified upstream, which is why any comparison against a configuration reports both values."
      ),
    maxBet: z.number().nullable().describe('Maximum stake for this customer on a selection.'),
    maxValuePercent: z
      .number()
      .nullable()
      .describe('Percentage of the maximum the customer could have staked on this bet.'),
    cumulativeMaxPercent: z.number().nullable(),
    overlayMaxPercent: z.number().nullable()
  })
  .describe(
    'The risk figures the upstream pricing system ACTUALLY USED for this bet. Bet-level, not per-leg. HOW they were derived is not available to this system and MUST NOT be explained or reconstructed.'
  );

/** Monetary amounts for a bet (data-model.md section 6). */
export const wagerAmountsSchema = z.object({
  stake: z.number(),
  currency: z.string().describe('Three-letter currency code.'),
  potentialPayout: z.number().nullable(),
  winnings: z.number().nullable(),
  refunds: z.number().nullable()
});

/**
 * The curated risk projection of one bet (data-model.md section 6, FR-009).
 *
 * A fixed subset of the ~200 fields the upstream document can request. Two omissions
 * are requirements, not curation: staff-authored notes (FR-004) and settlement
 * operators' names and comments (Principle V) are not requested at all.
 */
export const betSchema = z
  .object({
    betId: z.string(),
    receiptId: z
      .string()
      .nullable()
      .describe('The reference a customer quotes. You can search by this directly.'),
    accountId: z.string(),
    placedAt: z.string().describe('When the bet was placed, ISO 8601.'),
    status: z.string(),
    betType: z.string(),
    jurisdiction: z
      .string()
      .nullable()
      .describe('The jurisdiction the bet was placed in, as reported by the bet itself.'),
    catalogueInstanceId: z.string().nullable(),
    legCount: z.number().describe('How many legs the bet has.'),
    appliedRisk: appliedRiskFiguresSchema.nullable(),
    wager: wagerAmountsSchema,
    legs: z.array(betLegSchema)
  })
  .describe('A risk-shaped view of one placed bet.');

/**
 * Input of `find_customer_bets` — EXACTLY ONE identifier (FR-008).
 *
 * All three are optional at the schema level and the exactly-one rule is enforced in
 * the tool, so the error can name all three choices and describe the mistake. A zod
 * union would reject with a shape message the agent cannot act on as precisely.
 *
 * Note what is absent: no `instance`. QBS's `?instance=` is ROUTING, not scoping, and
 * constitution v1.2.0 forbids both sending it while multi-instance routing is disabled
 * and ever exposing it as a tool argument (FR-025).
 */
export const findCustomerBetsInputSchema = {
  accountId: z.string().min(1).optional().describe("Find all of one customer's bets."),
  betId: z.string().min(1).optional().describe('Find one bet by its internal identifier.'),
  receiptId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Find one bet by the receipt reference a customer quotes. No conversion to an internal identifier is needed.'
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum bets to return. Omit to use this deployment's configured cap; a larger value is clamped to it and the clamp is reported."
    )
};

/** Output of `find_customer_bets` — a discriminated union on `kind` (FR-012). */
export const findCustomerBetsOutputSchema = {
  kind: z
    .enum(['bets', 'none'])
    .describe(
      'bets: at least one bet matched. none: nothing matched — this is NOT an error and NOT an incomplete result. Report the absence and do not retry.'
    ),
  bets: z.array(betSchema).optional().describe('Present only when kind is "bets".'),
  totalMatched: z
    .number()
    .optional()
    .describe('How many bets matched upstream in total, which may exceed the number returned.'),
  orderingCaveat: z
    .string()
    .describe(
      'ALWAYS present. Relay it to the user: these are the first N bets of the upstream result set, most recent first, which may not be the globally most recent set.'
    ),
  limitReached: z
    .boolean()
    .describe(
      'True when the configured cap truncated the set. When true, say so — do not present the returned bets as all of them.'
    ),
  completeness: completenessSchema
};

export type NamedEntity = z.infer<typeof namedEntitySchema>;
export type BetLeg = z.infer<typeof betLegSchema>;
export type AppliedRiskFigures = z.infer<typeof appliedRiskFiguresSchema>;
export type WagerAmounts = z.infer<typeof wagerAmountsSchema>;
export type Bet = z.infer<typeof betSchema>;

/**
 * Why a leg's catalogue position is or is not known (data-model.md section 7).
 *
 * The two `notResolved…` values are kept separate deliberately: one is an upstream
 * failure, the other is this server's own identifier assumption being wrong. Folding
 * them would hide a systematic defect behind a generic error (Principle IV).
 */
export const legResolutionOutcomeSchema = z
  .enum([
    'resolved',
    'notResolvedUpstreamFailure',
    'notResolvedIdentifierUnusable',
    'notAttemptedBoundReached'
  ])
  .describe(
    'resolved: the position is known and overridesInScope is meaningful. notResolvedUpstreamFailure: the event lookup failed. notResolvedIdentifierUnusable: the bet carried no usable event identifier. notAttemptedBoundReached: the configured resolution limit was reached before this leg. For every value EXCEPT "resolved", nothing is known about this leg\'s restrictions.'
  );

/** One leg with its resolved catalogue position (data-model.md section 7). */
export const resolvedLegSchema = z
  .object({
    legNumber: z.number(),
    leg: betLegSchema,
    cataloguePath: z
      .array(cataloguePathNodeSchema)
      .nullable()
      .describe(
        'The risk-side catalogue path for this leg, broadest first; null when the leg is unresolved.'
      ),
    overridesInScope: z
      .array(hierarchyOverrideSchema)
      .describe(
        'Every override covering this leg\'s position. An override covering several legs appears on EACH of them. An EMPTY list means "no override covers this position" ONLY when resolution is "resolved" — on an unresolved leg it means NOTHING IS KNOWN, and must never be read as unrestricted.'
      ),
    // MANDATORY, not optional. It is the only thing distinguishing "no override
    // covers this leg" from "we could not find out", and those are opposite facts.
    resolution: legResolutionOutcomeSchema.describe(
      'Read this BEFORE overridesInScope. Only "resolved" means the override list is a complete statement about this leg.'
    ),
    resolvedVia: z
      .enum(['rampId', 'gbpId'])
      .nullable()
      .describe(
        "Which identifier field on the bet produced this leg's event lookup; null when unresolved. Diagnostic: which field is the correct one is not confirmed upstream, so this states the assumption this result relied on."
      )
  })
  .describe('One bet leg together with the risk settings in scope for its catalogue position.');

/** FR-018's four outcomes plus the not-attempted case — NOT incompleteness (FR-027). */
export const jurisdictionMatchOutcomeSchema = z
  .enum([
    'matched',
    'noConfigurationForJurisdiction',
    'jurisdictionNotMatched',
    'jurisdictionUnknown',
    'jurisdictionMatchNotAttempted'
  ])
  .describe(
    'matched: one configuration governed this bet, named in governingJurisdiction. noConfigurationForJurisdiction: the jurisdiction is real and the customer has no settings for it — a FACT ABOUT THE CUSTOMER. jurisdictionNotMatched: the jurisdiction could not be matched at all — a FAILURE OF THIS TOOL\'S MATCHING, not a fact about the customer. jurisdictionUnknown: the bet reported no jurisdiction. jurisdictionMatchNotAttempted: the customer\'s configurations could not be retrieved, so NO matching was performed — you know nothing about which settings applied, and completeness names the missing section. In every case except "matched" you MUST NOT tell the user the customer was on default settings, and you MUST NOT infer that the applied figures came from defaults — that the bet matched no configuration is not evidence about where its figures came from.'
  );

/** FR-020's three-valued comparison (data-model.md section 9). */
export const agreementVerdictSchema = z
  .object({
    field: z.enum(['stakeFactor', 'liabilityGroup']),
    verdict: z
      .enum(['consistent', 'differs', 'notComparable'])
      .describe(
        'consistent: the configured and applied values agree. differs: they do not — report both, and do NOT explain why. notComparable: no comparison could be made; see reason.'
      ),
    configuredValue: z
      .union([z.string(), z.number()])
      .nullable()
      .describe('Always shown, even when notComparable, so you can see what was compared.'),
    appliedValue: z.union([z.string(), z.number()]).nullable(),
    reason: z.string().nullable().describe('Why no comparison was possible; null otherwise.')
  })
  .describe(
    'A comparison between one configured setting and its applied counterpart. It does NOT explain how the applied value was derived — that is not available to this system.'
  );

/** A bet reference, for the multi-match case (FR-022). */
export const betRefSchema = z.object({
  betId: z.string(),
  receiptId: z.string().nullable(),
  accountId: z.string(),
  placedAt: z.string(),
  status: z.string(),
  betType: z.string()
});

/** Input of `get_bet_risk_context` — EXACTLY ONE of the two (FR-016). */
export const getBetRiskContextInputSchema = {
  betId: z.string().min(1).optional().describe("The bet's internal identifier."),
  receiptId: z
    .string()
    .min(1)
    .optional()
    .describe('The receipt reference a customer quotes. No conversion needed.')
  // No jurisdiction argument: the bet reports its own, so everything is derived from
  // the identifier (FR-016). And no instance — that is routing, not scoping.
};

/** Output of `get_bet_risk_context`. */
export const getBetRiskContextOutputSchema = {
  bet: betSchema.optional().describe('Absent only when the identifier matched several bets.'),
  jurisdictionMatch: jurisdictionMatchOutcomeSchema.optional(),
  jurisdictionMatchMechanism: z
    .enum(['ownConfiguration', 'platformContextList', 'derivation'])
    .nullable()
    .optional()
    .describe(
      'How the jurisdiction was matched, or null when it was not. "derivation" means the answer came from a US-state fallback rather than the platform\'s own jurisdiction list — treat it as less certain, and mention it if the user is relying on the jurisdiction being right.'
    ),
  governingJurisdiction: jurisdictionRefSchema
    .optional()
    .describe('Present ONLY when jurisdictionMatch is "matched".'),
  allJurisdictionConfigurations: z
    .array(customerRiskConfigurationSchema)
    .optional()
    .describe(
      'EVERY configuration the customer has, always — including when the jurisdiction did not match. Their presence is NOT evidence that any of them governed this bet.'
    ),
  resolvedLegs: z.array(resolvedLegSchema).optional(),
  agreement: z.array(agreementVerdictSchema).optional(),
  appliedFiguresAreBetLevel: z
    .boolean()
    .optional()
    .describe('True for a multi-leg bet, whose applied figures belong to the whole bet.'),
  attributionNotice: z
    .string()
    .optional()
    .describe('Present iff appliedFiguresAreBetLevel. Relay it verbatim.'),
  candidates: z
    .array(betRefSchema)
    .optional()
    .describe(
      'Present iff the identifier matched more than one bet. When present, NO risk context was assembled — ask the user which bet they mean.'
    ),
  completeness: completenessSchema
};

export type LegResolutionOutcomeValue = z.infer<typeof legResolutionOutcomeSchema>;
export type JurisdictionMatchValue = z.infer<typeof jurisdictionMatchOutcomeSchema>;
export type BetRef = z.infer<typeof betRefSchema>;

/**
 * The aggregation shape — REQUIRED, with no default (FR-014, SC-008).
 *
 * A default here would be the worst kind of convenience: three aggregations answer three
 * different questions, and silently picking one produces a confident answer to a question
 * the user did not ask. An absent value is an `argument` error naming all three.
 */
export const aggregationSchema = z
  .enum(['BET_TYPE', 'HIERARCHY_ENTITY', 'TIMEFRAME'])
  .describe(
    'REQUIRED — there is no default. BET_TYPE groups by bet type, HIERARCHY_ENTITY by catalogue entity, TIMEFRAME by period. Ask the user which they want rather than choosing one.'
  );

/** Upstream's time periods, passed through by name. */
export const periodSchema = z
  .enum(['_24_HOURS', 'LAST_WEEK', '_1_MONTH', '_3_MONTHS', '_6_MONTHS', '_1_YEAR', 'LIFETIME'])
  .describe("A time period. The leading underscore is upstream's own spelling.");

export const betTypeSchema = z
  .enum(['SINGLE', 'PARLAY', 'SGP', 'SGP_PLUS', 'TEASER'])
  .describe('SGP is a same-game parlay.');

export const placementStatusSchema = z
  .enum(['PRE_MATCH', 'IN_PLAY'])
  .describe('When the bet was placed relative to the event starting.');

/**
 * A hierarchy filter — ONE level only.
 *
 * Upstream rejects entities spanning several levels with
 * `MULTIPLE_HIERARCHY_LEVELS_NOT_COMBINABLE`, so the schema makes the invalid request
 * unrepresentable rather than letting the agent discover the rule from a `400`.
 *
 * `MARKET_TYPE` is absent deliberately: the request body accepts only `SUPERCLASS`,
 * `SUBCLASS` and `EVENTTYPE` (customer-metrics.yaml), so offering a fourth level would
 * invite a filter upstream silently ignores.
 */
export const hierarchyFilterSchema = z
  .object({
    level: z
      .enum(['SUPERCLASS', 'SUBCLASS', 'EVENT_TYPE'])
      .describe('Exactly one level per request — entities from several cannot be combined.'),
    // NOT `entityIds`: QBS uses that name for a leg's four-member identifier bag, and a
    // model shown one name for two different things will conflate them.
    catalogueEntityIds: z
      .array(z.string().min(1))
      .min(1)
      .describe('Catalogue entity identifiers at that level. Use the catalogue tools to find them.')
  })
  .describe('Restrict the metrics to part of the catalogue. One level only.');

/**
 * The CURATED measure subset (data-model.md section 10).
 *
 * Upstream returns ~40 measures in one flat bag. A tool schema of 40 numbers is a schema a
 * model cannot use, so this keeps the commercial and behavioural core and drops the rest —
 * a curation decision under Principle IV, and additive if a measure is wanted later.
 *
 * Two exclusions are not curation but policy: `vipManager` names a member of staff
 * (Principle V), and the promo/device-link/internal-scoring measures are not
 * self-describing, so a model shown them would narrate a guess.
 */
export const metricsFiguresSchema = z
  .object({
    betCount: z.number().nullable(),
    grossStake: z.number().nullable(),
    settledStake: z.number().nullable(),
    averageStake: z.number().nullable(),
    tradingRevenue: z.number().nullable(),
    tradingMargin: z.number().nullable(),
    expectedMargins: z.number().nullable(),
    inPlayStake: z.number().nullable(),
    averageLegsPerBet: z.number().nullable(),
    averageLegPrice: z.number().nullable(),
    distinctEvents: z.number().nullable(),
    playerDays: z.number().nullable(),
    nearLimitBet: z.number().nullable(),
    firstBetDate: z.string().nullable(),
    lastBetDate: z.string().nullable()
  })
  .describe(
    'A curated subset of the measures upstream computes. A null means upstream did not report that measure — NOT zero.'
  );

/**
 * One aggregation bucket, DISCRIMINATED by `keyKind`.
 *
 * A discriminator rather than three sibling optional fields, so a bet type cannot be read
 * as a period. With `betType`/`period`/`hierarchyEntity` as siblings, a model seeing one
 * populated field would have to infer which question it answers — and `SINGLE` and
 * `_1_MONTH` are both plausible-looking keys.
 */
export const metricsGroupSchema = z
  .object({
    key: z.string().describe('The bucket this row is for: a bet type, a period, or an entity id.'),
    keyKind: z
      .enum(['betType', 'hierarchyEntity', 'period'])
      .describe('What `key` IS. Read this before interpreting `key`.'),
    keyName: z
      .string()
      .nullable()
      .describe('A human-readable name, for a hierarchy entity; null for the other kinds.'),
    hierarchyLevel: z
      .enum(['SUPERCLASS', 'SUBCLASS', 'EVENT_TYPE', 'MARKET_TYPE'])
      .nullable()
      .describe('Present only when keyKind is hierarchyEntity.'),
    figures: metricsFiguresSchema
  })
  .describe('One row of the aggregation the caller asked for.');

/** Input of `get_customer_betting_metrics`. */
export const getCustomerBettingMetricsInputSchema = {
  accountId: z.string().min(1).describe("The customer's account identifier."),
  aggregation: aggregationSchema,
  period: periodSchema.optional().describe('Restrict to one period. Omit for all time.'),
  betTypes: z
    .array(betTypeSchema)
    .min(1)
    .optional()
    .describe('Restrict to these bet types. Omit for all.'),
  placementStatus: z
    .array(placementStatusSchema)
    .min(1)
    .optional()
    .describe('Restrict to pre-match or in-play. Omit for both.'),
  jurisdictions: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      'Jurisdiction CODES to restrict to. Get them from list_jurisdiction_contexts — a code this server does not recognise is an error, never a silently dropped filter.'
    ),
  hierarchy: hierarchyFilterSchema.optional()
  // No `instance`: a customer call is scoped by the account identifier alone.
};

/** Output of `get_customer_betting_metrics`. */
export const getCustomerBettingMetricsOutputSchema = {
  accountId: z.string(),
  aggregation: aggregationSchema.describe(
    'The aggregation these figures are grouped by — echoed back so the answer states its own shape.'
  ),
  lifetime: metricsFiguresSchema
    .nullable()
    .describe('Lifetime totals, UNAFFECTED by the filters. Never compare these to a filtered row.'),
  filteredTotal: metricsFiguresSchema
    .nullable()
    .describe('Totals across the filtered set. This is what the groups below sum to.'),
  groups: z.array(metricsGroupSchema).describe('One row per bucket. May be empty.'),
  noDataNotice: z
    .string()
    .optional()
    .describe(
      'Present ONLY when the figures carry upstream\'s "no data" signature: every measure zero or absent, and no bet dates. When present you MUST relay it and MUST NOT state that the customer has not bet — the reporting warehouse zero-fills what it has no data for, so a gap and genuine inactivity are indistinguishable here. Absent on a normal answer.'
    ),
  completeness: completenessSchema
};

export type Aggregation = z.infer<typeof aggregationSchema>;
export type Period = z.infer<typeof periodSchema>;
export type BetTypeValue = z.infer<typeof betTypeSchema>;
export type PlacementStatus = z.infer<typeof placementStatusSchema>;
export type HierarchyFilter = z.infer<typeof hierarchyFilterSchema>;
export type MetricsFigures = z.infer<typeof metricsFiguresSchema>;
export type MetricsGroup = z.infer<typeof metricsGroupSchema>;

/**
 * The arguments `get_customer_betting_metrics` accepts.
 *
 * `aggregation` is typed as OPTIONAL here even though the input schema makes it required,
 * so the tool's own required-argument check is reachable and testable. The MCP layer
 * rejects an absent value first; this keeps the tool honest when called directly, and
 * FR-014's error is the one an agent should see either way.
 */
export interface GetCustomerBettingMetricsArgs {
  readonly accountId?: string | undefined;
  readonly aggregation?: Aggregation | undefined;
  readonly period?: Period | undefined;
  readonly betTypes?: readonly BetTypeValue[] | undefined;
  readonly placementStatus?: readonly PlacementStatus[] | undefined;
  readonly jurisdictions?: readonly string[] | undefined;
  readonly hierarchy?: HierarchyFilter | undefined;
}
