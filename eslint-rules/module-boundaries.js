/**
 * Local ESLint rule enforcing constitution Principle III:
 *
 *   - `src/core/**` MUST NOT import from `src/domains/**`
 *   - one domain MUST NOT import from another domain
 *
 * The rule resolves each import specifier against the importing file's own path,
 * so it cannot be defeated by the relative depth of the import (`../../betting/x`
 * contains no literal "domains" segment and would slip past a specifier-pattern
 * rule). This is enforcement, not convention — the boundary is the reason the
 * modular monolith can be split later without a rewrite.
 */

import path from 'node:path';

/** @returns {{ zone: 'core' } | { zone: 'domain', name: string } | { zone: 'other' }} */
function zoneOf(absPath) {
  const normalised = absPath.split(path.sep).join('/');
  const domain = /\/src\/domains\/([^/]+)(\/|$)/.exec(normalised);
  if (domain) return { zone: 'domain', name: domain[1] };
  if (/\/src\/core(\/|$)/.test(normalised)) return { zone: 'core' };
  return { zone: 'other' };
}

/** Resolve an import specifier to an absolute path, or null when it is a bare package. */
function resolveSpecifier(specifier, fromFile) {
  if (!specifier.startsWith('.')) return null;
  return path.resolve(path.dirname(fromFile), specifier);
}

const noCrossBoundaryImport = {
  meta: {
    type: 'problem',
    docs: { description: 'Enforce core ↛ domains and domain ↛ domain import boundaries' },
    schema: [],
    messages: {
      coreToDomain:
        'core/ must not import from domains/ (constitution Principle III). Move the shared logic into core/ instead.',
      domainToDomain:
        'Domain "{{from}}" must not import from domain "{{to}}" (constitution Principle III). Compose through core/ instead.'
    }
  },
  create(context) {
    const fromFile = context.filename ?? context.getFilename();
    const from = zoneOf(fromFile);
    if (from.zone === 'other') return {};

    function check(node, specifier) {
      const target = resolveSpecifier(specifier, fromFile);
      if (target === null) return;
      const to = zoneOf(target);
      if (to.zone === 'domain' && from.zone === 'core') {
        context.report({ node, messageId: 'coreToDomain' });
        return;
      }
      if (to.zone === 'domain' && from.zone === 'domain' && to.name !== from.name) {
        context.report({
          node,
          messageId: 'domainToDomain',
          data: { from: from.name, to: to.name }
        });
      }
    }

    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source.value),
      ExportAllDeclaration: (node) => node.source && check(node, node.source.value),
      ImportExpression: (node) =>
        node.source.type === 'Literal' &&
        typeof node.source.value === 'string' &&
        check(node, node.source.value)
    };
  }
};

export default {
  meta: { name: 'module-boundaries' },
  rules: { 'no-cross-boundary-import': noCrossBoundaryImport }
};
