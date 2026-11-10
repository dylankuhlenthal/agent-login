export type RefusalCode =
  | 'NO_VAULT'
  | 'BAD_CONFIG'
  | 'BAD_ACCOUNT_KEY'
  | 'TOKEN_MISSING'
  | 'TOKEN_TOO_OPEN'
  | 'UNKNOWN_ACCOUNT'
  | 'LOOKUP_FAILED'
  | 'ITEM_INCOMPLETE'
  | 'NO_ACCOUNT_CONFIG'
  | 'BAD_ACCOUNT_CONFIG'
  | 'ACCOUNT_CONFIG_EXISTS'
  | 'SITE_NOT_ALLOWED'
  | 'FIELD_NOT_FOUND'
  | 'NOT_A_PASSWORD_FIELD'
  | 'SIGN_IN_FAILED'
  | 'PASSWORD_IN_PROFILE';

export class Refusal extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}
