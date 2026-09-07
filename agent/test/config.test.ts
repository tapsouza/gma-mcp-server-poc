import { describe, expect, it } from 'vitest';
import {
  AgentConfigError,
  DEFAULT_CHILD_LOG_LEVEL,
  DEFAULT_MODEL_ID,
  loadAgentConfig
} from '../config.js';

/**
 * Configuration validation (T036, T037; FR-010, FR-014, SC-005, SC-008).
 *
 * Must-cover cases:
 *  - each required variable, when absent, produces a message NAMING that variable
 *  - validation returns before anything is spawned
 *  - `OKTA_CLIENT_ID` is NOT required, so the supplied-token path works with no Okta app
 *  - no credential or credential fragment appears in any message on any failure path
 */

const TOKEN = 'supplied-token-value-9f2a4c8e1b';

function completeEnv(): NodeJS.ProcessEnv {
  return {
    GMA_BASE_URL: 'https://gma.example-nonprod.invalid',
    GMA_DEFAULT_INSTANCES: 'PP,BF',
    OKTA_ISSUER: 'https://example.okta.invalid/oauth2/aus000',
    AWS_REGION: 'us-east-1',
    GMA_USER_TOKEN: TOKEN,
    AWS_SECRET_ACCESS_KEY: 'aws-secret-value-7d3f9a2c',
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEKEYID0000'
  };
}

const REQUIRED = ['GMA_BASE_URL', 'GMA_DEFAULT_INSTANCES', 'OKTA_ISSUER', 'AWS_REGION'] as const;

describe('loadAgentConfig', () => {
  it('accepts a complete environment', () => {
    const config = loadAgentConfig(completeEnv());

    expect(config.gmaBaseUrl).toBe('https://gma.example-nonprod.invalid');
    expect(config.defaultInstances).toBe('PP,BF');
    expect(config.awsRegion).toBe('us-east-1');
    expect(config.suppliedToken).toBe(TOKEN);
  });

  it('applies the documented defaults', () => {
    const config = loadAgentConfig(completeEnv());

    expect(config.modelId).toBe(DEFAULT_MODEL_ID);
    // `warn`, not the server's own `info`: at `info` the server's log lines scribble
    // over the prompt mid-typing (contracts/config.md §6).
    expect(config.childLogLevel).toBe(DEFAULT_CHILD_LOG_LEVEL);
    expect(config.childLogLevel).toBe('warn');
  });

  describe('case: each required variable is named when absent (FR-010, SC-005)', () => {
    for (const name of REQUIRED) {
      it(`names ${name}`, () => {
        const env = completeEnv();
        delete env[name];

        expect(() => loadAgentConfig(env)).toThrow(AgentConfigError);
        expect(() => loadAgentConfig(env)).toThrow(name);
      });

      it(`names ${name} when it is present but blank`, () => {
        // A variable set to whitespace is the shape a half-finished `.env` takes, and
        // must fail exactly like an absent one rather than reaching the child.
        const env = { ...completeEnv(), [name]: '   ' };

        expect(() => loadAgentConfig(env)).toThrow(name);
      });
    }
  });

  describe('case: invalid values are rejected, naming the variable', () => {
    it('rejects a GMA_BASE_URL that is not an absolute http(s) URL', () => {
      const env = { ...completeEnv(), GMA_BASE_URL: 'gma.example.invalid' };

      expect(() => loadAgentConfig(env)).toThrow('GMA_BASE_URL');
    });

    it('rejects an OKTA_ISSUER that is not an absolute http(s) URL', () => {
      const env = { ...completeEnv(), OKTA_ISSUER: '/oauth2/aus000' };

      expect(() => loadAgentConfig(env)).toThrow('OKTA_ISSUER');
    });

    it('rejects GMA_DEFAULT_INSTANCES listing no usable code', () => {
      const env = { ...completeEnv(), GMA_DEFAULT_INSTANCES: ' , , ' };

      expect(() => loadAgentConfig(env)).toThrow('GMA_DEFAULT_INSTANCES');
    });

    it('rejects an unknown LOG_LEVEL', () => {
      const env = { ...completeEnv(), LOG_LEVEL: 'verbose' };

      expect(() => loadAgentConfig(env)).toThrow('LOG_LEVEL');
    });
  });

  describe('case: OKTA_CLIENT_ID is not required (FR-016, FR-033)', () => {
    it('loads with no OKTA_CLIENT_ID at all', () => {
      const env = completeEnv();
      delete env.OKTA_CLIENT_ID;

      // Validating it eagerly would break the supplied-token path for everyone until an
      // Okta application exists — which is precisely what FR-033 keeps from blocking
      // Stories 1-3.
      const config = loadAgentConfig(env);
      expect(config.oktaClientId).toBeUndefined();
    });
  });

  describe('case: GMA_USER_TOKEN is optional (contracts/config.md §1)', () => {
    it('loads with no GMA_USER_TOKEN, leaving the ladder to produce one', () => {
      const env = completeEnv();
      delete env.GMA_USER_TOKEN;

      const config = loadAgentConfig(env);
      expect(config.suppliedToken).toBeUndefined();
    });
  });

  describe('case: AWS credentials never enter the config object (FR-011)', () => {
    it('exposes no AWS credential field', () => {
      const config = loadAgentConfig(completeEnv());

      // The ABSENCE is the mechanism: a value not in the config cannot be forwarded to
      // the child by a future edit that spreads the config into the child's environment.
      const serialised = JSON.stringify(config);
      expect(serialised).not.toContain('aws-secret-value-7d3f9a2c');
      expect(serialised).not.toContain('AKIAEXAMPLEKEYID0000');
      expect(Object.keys(config)).not.toContain('awsSecretAccessKey');
      expect(Object.keys(config)).not.toContain('awsAccessKeyId');
    });
  });

  describe('case: no credential material appears in any failure message (FR-014, SC-008)', () => {
    // Every failure path, not a sample: SC-008 is about the path someone forgets.
    const failureCases: { name: string; env: NodeJS.ProcessEnv }[] = [
      ...REQUIRED.map((name) => {
        const env = completeEnv();
        delete env[name];
        return { name: `missing ${name}`, env };
      }),
      { name: 'invalid GMA_BASE_URL', env: { ...completeEnv(), GMA_BASE_URL: 'nope' } },
      { name: 'invalid OKTA_ISSUER', env: { ...completeEnv(), OKTA_ISSUER: 'nope' } },
      {
        name: 'empty GMA_DEFAULT_INSTANCES',
        env: { ...completeEnv(), GMA_DEFAULT_INSTANCES: ',' }
      },
      { name: 'invalid LOG_LEVEL', env: { ...completeEnv(), LOG_LEVEL: 'loud' } }
    ];

    for (const { name, env } of failureCases) {
      it(`leaks nothing on: ${name}`, () => {
        let message = '';
        try {
          loadAgentConfig(env);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        expect(message.length).toBeGreaterThan(0);
        expect(message).not.toContain(TOKEN);
        expect(message).not.toContain('aws-secret-value-7d3f9a2c');
        expect(message).not.toContain('AKIAEXAMPLEKEYID0000');
        // Not even a fragment: a partial token is still a credential leak.
        expect(message).not.toContain(TOKEN.slice(0, 12));
      });
    }
  });
});
