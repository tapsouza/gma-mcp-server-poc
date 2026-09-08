import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { ToolError } from '../../src/core/types.js';

/** A complete, valid environment. Individual tests remove or corrupt one key. */
const validEnv = (): NodeJS.ProcessEnv => ({
  GMA_BASE_URL: 'https://gma.example-nonprod.invalid',
  GMA_DEFAULT_INSTANCES: 'PP,BF',
  OKTA_ISSUER: 'https://example.okta.invalid/oauth2/aus0000000000000000'
});

describe('loadConfig', () => {
  describe('case: required variable missing → refuses, naming that variable (FR-019, SC-007)', () => {
    for (const varName of ['GMA_BASE_URL', 'GMA_DEFAULT_INSTANCES', 'OKTA_ISSUER'] as const) {
      it(`refuses to start when ${varName} is absent, naming it`, () => {
        const env = validEnv();
        delete env[varName];

        expect(() => loadConfig(env)).toThrow(ToolError);
        try {
          loadConfig(env);
          expect.unreachable('loadConfig must throw when a required variable is absent');
        } catch (error) {
          const toolError = error as ToolError;
          expect(toolError.kind).toBe('config');
          expect(toolError.retryable).toBe(false);
          expect(toolError.message).toContain(varName);
        }
      });

      it(`treats a blank ${varName} as absent rather than as a value`, () => {
        const env = { ...validEnv(), [varName]: '   ' };
        expect(() => loadConfig(env)).toThrowError(new RegExp(varName));
      });
    }

    it('names every missing variable at once, so one restart fixes them all', () => {
      const error = (() => {
        try {
          loadConfig({});
          return null;
        } catch (e) {
          return e as ToolError;
        }
      })();

      expect(error).toBeInstanceOf(ToolError);
      expect(error?.message).toContain('GMA_BASE_URL');
      expect(error?.message).toContain('GMA_DEFAULT_INSTANCES');
      expect(error?.message).toContain('OKTA_ISSUER');
    });
  });

  describe('case: invalid URL rejected', () => {
    it.each([
      ['a bare hostname', 'gma.example.invalid'],
      ['a relative path', '/v5/instances'],
      ['a non-http scheme', 'ftp://gma.example.invalid'],
      ['nonsense', 'not a url at all']
    ])('rejects GMA_BASE_URL that is %s', (_label, value) => {
      expect(() => loadConfig({ ...validEnv(), GMA_BASE_URL: value })).toThrowError(
        /GMA_BASE_URL must be an absolute http\(s\) URL/
      );
    });

    it('rejects an OKTA_ISSUER that is not an absolute URL', () => {
      expect(() => loadConfig({ ...validEnv(), OKTA_ISSUER: 'fanduel.okta.com' })).toThrowError(
        /OKTA_ISSUER must be an absolute http\(s\) URL/
      );
    });

    it('strips a trailing slash from the base URL so path joining cannot double it', () => {
      const config = loadConfig({ ...validEnv(), GMA_BASE_URL: 'https://gma.invalid///' });
      expect(config.gmaBaseUrl).toBe('https://gma.invalid');
    });
  });

  describe('case: defaults applied', () => {
    it('applies documented defaults when the optional variables are absent', () => {
      const config = loadConfig(validEnv());

      expect(config.requestTimeoutMs).toBe(30_000);
      expect(config.maxCandidates).toBe(25);
      expect(config.logLevel).toBe('info');
    });
    it('applies defaults when an optional variable is present but empty', () => {
      const config = loadConfig({
        ...validEnv(),
        GMA_TIMEOUT_MS: '',
        GMA_MAX_CANDIDATES: ''
      });

      expect(config.requestTimeoutMs).toBe(30_000);
      expect(config.maxCandidates).toBe(25);
    });

    it('honours explicit overrides of the optional variables', () => {
      const config = loadConfig({
        ...validEnv(),
        GMA_TIMEOUT_MS: '1500',
        GMA_MAX_CANDIDATES: '5',
        LOG_LEVEL: 'debug'
      });

      expect(config.requestTimeoutMs).toBe(1500);
      expect(config.maxCandidates).toBe(5);
      expect(config.logLevel).toBe('debug');
    });

    it.each([
      ['zero', '0'],
      ['negative', '-1'],
      ['fractional', '1.5'],
      ['non-numeric', 'thirty seconds']
    ])('rejects a %s GMA_TIMEOUT_MS rather than silently defaulting', (_label, value) => {
      expect(() => loadConfig({ ...validEnv(), GMA_TIMEOUT_MS: value })).toThrowError(
        /GMA_TIMEOUT_MS must be a positive integer/
      );
    });

    it('rejects a maxCandidates that is not a positive integer', () => {
      expect(() => loadConfig({ ...validEnv(), GMA_MAX_CANDIDATES: '0' })).toThrowError(
        /GMA_MAX_CANDIDATES must be a positive integer/
      );
    });

    it('rejects an unrecognised LOG_LEVEL rather than falling back silently', () => {
      expect(() => loadConfig({ ...validEnv(), LOG_LEVEL: 'verbose' })).toThrow(ToolError);
    });
  });

  describe('case: the customer-domain bounds are optional with a default (Principle V, FR-010, FR-023)', () => {
    it('applies both documented defaults when neither variable is set', () => {
      // The property that matters: an existing deployment that has never heard of
      // these variables still starts. Making either one required would turn an
      // additive domain into a breaking change to every deployment's environment.
      const config = loadConfig(validEnv());

      expect(config.customerMaxBets).toBe(20);
      expect(config.customerMaxEventResolutions).toBe(10);
    });

    it('applies the defaults when the variables are present but empty', () => {
      const config = loadConfig({
        ...validEnv(),
        CUSTOMER_MAX_BETS: '',
        CUSTOMER_MAX_EVENT_RESOLUTIONS: ''
      });

      expect(config.customerMaxBets).toBe(20);
      expect(config.customerMaxEventResolutions).toBe(10);
    });

    it('honours an explicit value for each, so a test or a deployment can tighten a bound', () => {
      const config = loadConfig({
        ...validEnv(),
        CUSTOMER_MAX_BETS: '5',
        CUSTOMER_MAX_EVENT_RESOLUTIONS: '2'
      });

      expect(config.customerMaxBets).toBe(5);
      expect(config.customerMaxEventResolutions).toBe(2);
    });

    it.each([
      ['zero', '0'],
      ['negative', '-1'],
      ['fractional', '1.5'],
      ['non-numeric', 'twenty']
    ])('rejects a %s CUSTOMER_MAX_BETS, naming the variable', (_label, value) => {
      expect(() => loadConfig({ ...validEnv(), CUSTOMER_MAX_BETS: value })).toThrowError(
        /CUSTOMER_MAX_BETS must be a positive integer/
      );
    });

    it.each([
      ['zero', '0'],
      ['negative', '-3'],
      ['fractional', '2.5'],
      ['non-numeric', 'ten']
    ])('rejects a %s CUSTOMER_MAX_EVENT_RESOLUTIONS, naming the variable', (_label, value) => {
      expect(() =>
        loadConfig({ ...validEnv(), CUSTOMER_MAX_EVENT_RESOLUTIONS: value })
      ).toThrowError(/CUSTOMER_MAX_EVENT_RESOLUTIONS must be a positive integer/);
    });

    it('reports a config error kind that only an operator can act on', () => {
      try {
        loadConfig({ ...validEnv(), CUSTOMER_MAX_BETS: '0' });
        expect.unreachable('loadConfig must refuse a non-positive bound');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('config');
        expect(toolError.retryable).toBe(false);
      }
    });
  });

  describe('instance list parsing', () => {
    it('splits and trims the default instance list', () => {
      const config = loadConfig({ ...validEnv(), GMA_DEFAULT_INSTANCES: ' PP , BF ,SBG ' });
      expect(config.defaultInstances).toEqual(['PP', 'BF', 'SBG']);
    });

    it('rejects a list that is only separators, rather than defaulting to all instances', () => {
      expect(() => loadConfig({ ...validEnv(), GMA_DEFAULT_INSTANCES: ',,,' })).toThrowError(
        /at least one instance code/
      );
    });
  });

  describe('case: no operational value is readable from a tool argument (FR-018)', () => {
    it('exposes exactly the eight configured fields and nothing agent-supplied', () => {
      const config = loadConfig(validEnv());

      // Exhaustive by design: a new field has to be added here deliberately, which
      // is what makes an accidentally-agent-supplied operational value visible in
      // review. The two customer bounds were added by feature 004.
      expect(Object.keys(config).sort()).toEqual([
        'customerMaxBets',
        'customerMaxEventResolutions',
        'defaultInstances',
        'gmaBaseUrl',
        'logLevel',
        'maxCandidates',
        'oktaIssuer',
        'requestTimeoutMs'
      ]);
    });

    it('returns a frozen object, so no later caller can retarget the upstream at runtime', () => {
      const config = loadConfig(validEnv());

      expect(Object.isFrozen(config)).toBe(true);
      expect(() => {
        (config as { gmaBaseUrl: string }).gmaBaseUrl = 'https://gma-prod.invalid';
      }).toThrow();
      expect(config.gmaBaseUrl).toBe('https://gma.example-nonprod.invalid');
    });

    it('reads only from the environment passed to it, never from a request', () => {
      // Proven by construction: loadConfig's only input is an env record. If it
      // grew a second, request-derived parameter this test would fail to compile.
      expect(loadConfig.length).toBeLessThanOrEqual(1);
    });
  });
});
