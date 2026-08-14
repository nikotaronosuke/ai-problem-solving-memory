/**
 * Client credentials.
 *
 * One entry point, so nothing outside this directory reaches into its parts.
 * What crosses the boundary is the authenticator, the repository, and the
 * principal a verified credential resolves to — never a token, and never a
 * digest.
 */

export {
  createCredentialAuthenticator,
  CredentialAuthenticationError,
  type AuthenticatedPrincipal,
  type AuthenticationFailure,
  type CredentialAuthenticator,
} from './authenticator.js';
export {
  createCredentialRepository,
  type CredentialLookupRecord,
  type CredentialRepository,
  type IssueClientCredentialInput,
  type IssueCredentialForClientInput,
} from './repository.js';
