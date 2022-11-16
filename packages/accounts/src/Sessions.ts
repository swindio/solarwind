import {
  hashString,
  NodeLogger,
  nonNullValues,
  StringValue,
  ulid,
  Waterfall,
} from '@backland/utils';
import { createHooks } from 'plugin-hooks';

import { AccountDocument, AccountEntity } from './entity/AccountEntity';
import { SessionEntity, SessionInput } from './entity/SessionEntity';
import { ConnectionInformation } from './types/ConnectionInformation';
import { LoginResult } from './types/LoginResult';
import { SessionDocument } from './types/SessionType';
import { AccountError } from './utils/AccountError';
import {
  createSessionTokenString,
  ParsedSessionToken,
  parseSessionTokenString,
  signAccountJWT,
  verifySessionJWT,
} from './utils/crypto';

export type SessionDurationConfig = {
  sessionToken: StringValue;
  refreshToken: StringValue;
};

export interface SessionsOptions {
  durations?: SessionDurationConfig;
  getTokenSecret: (request: SessionRequest) => string | Promise<string>;
}

const _defaultSessionDuration = () =>
  ({
    sessionToken: '90m',
    refreshToken: '7d',
  } as const);

export class Sessions {
  private options: Required<SessionsOptions>;

  hooks: AccountSessionHooks;

  getTokenSecret: NonNullable<SessionsOptions['getTokenSecret']>;

  constructor(options: SessionsOptions) {
    this.options = { durations: _defaultSessionDuration(), ...options };
    this.getTokenSecret = options.getTokenSecret;

    this.hooks = createAccountSessionHooks(options);
    const self = this;

    this.hooks.onRequest.register(async function sessionHandler(request) {
      await self.trySetSession(request);
      return request;
    });
  }

  handleRequest = async <T extends SessionRequest>(request: T): Promise<T> => {
    return (await this.hooks.onRequest.exec(request, {})) as T; // the first hook handler is registered in constructor
  };

  getConnectionInfo = (request: SessionRequest): ConnectionInformation => {
    return nonNullValues(
      {
        userAgent: request.userAgent,
        ip: request.requestIp,
      },
      'Invalid ConnectionInformation in request.'
    );
  };
  /**
   * Checks for tokens in the provided session object and renew
   * tokens if session is valid
   * @param sessionRequest
   */
  public async trySetSession(
    sessionRequest: SessionRequest
  ): Promise<LoginResult | undefined> {
    if (sessionRequest.authToken) {
      const refreshInput: Omit<RefreshTokensInput, 'secret'> = {
        request: sessionRequest,
        authToken: sessionRequest.authToken,
      };

      const result = await this.refreshTokens({
        ...refreshInput,
        secret: await this.getTokenSecret(sessionRequest),
      });

      const res = await this.hooks.onRefreshTokens.exec(
        { ...sessionRequest, result },
        sessionRequest
      );

      return res.result;
    }

    return;
  }

  refreshTokens = async (input: RefreshTokensInput): Promise<LoginResult> => {
    const {
      authToken, //
      secret,
      request,
    } = input;

    try {
      let parsedAuthToken: ParsedSessionToken;

      try {
        const { data: tokenString } = verifySessionJWT({
          sessionToken: authToken,
          secret,
        });
        parsedAuthToken = parseSessionTokenString(tokenString, 'R');
      } catch (err) {
        throw new AccountError(
          'TokenVerificationFailed',
          'Tokens are not valid.'
        );
      }

      const { dataAID } = parsedAuthToken;
      const filter = { id: dataAID.input };

      const { item: account } = await AccountEntity.findOne({
        filter,
        context: request,
      });

      if (!account) {
        throw new AccountError('UserNotFound', { filter });
      }

      return await this.upsertRefreshTokenAndSessionDocument({
        authToken: parsedAuthToken,
        account,
        request,
        op: 'update',
      });
    } catch (caughtError: any) {
      const error = await this.hooks.onUpsertSessionError.exec(
        caughtError,
        request
      );

      if (typeof error?.message === 'string') {
        throw error;
      } else {
        throw caughtError;
      }
    }
  };

  /**
   * @description Creates a refreshToken
   * @description Create a new session if existingSession is null
   *   - tokens are strings created by Sessions.createTokenString
   *       containing ParsedSessionToken data
   */
  public async upsertRefreshTokenAndSessionDocument(
    input: {
      account: AccountDocument;
      request: RefreshTokensInput['request'];
    } & (
      | { op: 'insert' }
      | {
          op: 'update';
          authToken: ParsedSessionToken;
        }
    )
  ): Promise<LoginResult> {
    const { account, request } = input;
    const connectionInfo = this.getConnectionInfo(request);

    const accountId = account.accountId;

    let usedSession: SessionDocument | undefined = undefined;

    if (input.op === 'update') {
      const { authToken, account, request } = input;
      nonNullValues({ authToken, account, request });

      if (authToken.dataUAHash !== hashString(connectionInfo.userAgent)) {
        throw new AccountError('InvalidSession', 'AGENT_CHANGED');
      }

      const updated = await SessionEntity.updateOne({
        filter: {
          id: authToken.dataSID.input,
        },
        update: {
          $set: {
            connectionInfo,
          },
        },
      });

      if (!updated.item) {
        throw new AccountError(
          'SessionNotFound',
          updated.error || `Session "${authToken.dataSID.input}" not found.`
        );
      }

      usedSession = updated.item;
    }

    if (input.op === 'insert') {
      const sessionInput: SessionInput = {
        accountId,
        token: '', // added below
        valid: true,
        ulid: ulid(),
        connectionInfo,
      };

      sessionInput.id = SessionEntity.getDocumentId(sessionInput);
      sessionInput.token = createSessionTokenString({
        s: sessionInput.id,
        a: account.id,
        connectionInfo,
        k: 'S',
      });

      const created = await SessionEntity.createOne({
        item: sessionInput,
      });

      if (!created.item || created.error) {
        NodeLogger.logError(created.error);
        throw new AccountError(
          'AuthenticationFailed',
          'Can not create session'
        );
      }

      usedSession = created.item;
    }

    usedSession = nonNullValues({ usedSession, op: input.op }).usedSession;

    if (usedSession.valid !== true) {
      throw new AccountError(
        'InvalidSession',
        `Session ${usedSession.id} is marked with valid: ${usedSession.valid}.`
      );
    }

    const secret = await this.getTokenSecret(request);

    const sessionToken = signAccountJWT({
      secret,
      data: usedSession.token,
      config: {
        expiresIn: this.options.durations.sessionToken,
      },
    });

    const refreshTokenString = createSessionTokenString({
      s: usedSession.id,
      a: account.id,
      k: 'R',
      connectionInfo,
    });

    const refreshToken = signAccountJWT({
      secret,
      data: refreshTokenString,
      config: {
        expiresIn: this.options.durations.refreshToken,
      },
    });

    account.session = [
      ...(account.session || []).filter((el) => el.id !== usedSession!.id),
      usedSession,
    ];

    request.authToken = refreshToken;
    request.user = account;

    return {
      sessionDocument: usedSession,
      sessionToken,
      refreshToken,
      authToken: refreshToken,
      account,
    };
  }

  logout = async (input: {
    authToken: string;
    request: SessionRequest;
  }): Promise<boolean> => {
    const { authToken, request } = input;

    const { accountId } = nonNullValues(
      { accountId: request.user?.accountId },
      'No user found'
    );

    const invalidated = await this.invalidateSessions({
      mode: 'one',
      accountId,
      request,
      authToken,
    });

    return !!invalidated;
  };

  invalidateSessions = async (
    input:
      | {
          accountId: string;
          request: SessionRequest;
        } & ({ authToken: string; mode: 'one' } | { mode: 'all' })
  ): Promise<number> => {
    const { request, accountId } = input;

    const authToken = input.mode === 'one' ? input.authToken : undefined;

    const filter = await (async () => {
      if (authToken) {
        const secret = await this.getTokenSecret(request);

        try {
          const jwtData = verifySessionJWT({
            sessionToken: authToken,
            secret,
            config: {
              ignoreExpiration: true,
            },
          });
          const { dataSID } = parseSessionTokenString(jwtData.data, 'R');
          return { id: dataSID.input, accountId };
        } catch (e) {
          if (request.user) {
            // in case jwt verification failed, because secret changed, etc.
            return { accountId: request.user.accountId };
          }
        }
      }
      return { accountId };
    })();

    const invalidated = await SessionEntity.updateMany({
      filter,
      condition: { valid: true, accountId },
      update: {
        $set: {
          valid: false,
        },
      },
    });

    await request.onCallDestroySession?.(request);
    delete request.authToken;
    delete request.user;
    request.sessionDestroyed = true;

    if (!invalidated.modifiedCount) {
      throw new AccountError(
        'SessionNotFound',
        invalidated.error || `No session found for account "${accountId}".`
      );
    }

    return invalidated.modifiedCount;
  };
}

export type SessionRequest = {
  authToken?: string;
  sessionDestroyed?: boolean;
  requestIp: string;
  userAgent: string;
  onCallDestroySession: null | ((request: SessionRequest) => unknown);
  user?: AccountDocument;
};

export type SessionHooksContext = {};

export function createAccountSessionHooks(_options: SessionsOptions) {
  const factory = createHooks<SessionRequest, SessionHooksContext>({
    onPluginExecEnd(ctx) {
      const current = ctx.current;

      if (!current || typeof current !== 'object') {
        throw new AccountError('InvalidRequest');
      }

      if (
        current.onCallDestroySession &&
        typeof current.onCallDestroySession !== 'function'
      ) {
        throw new AccountError(
          'InvalidRequest',
          'Expected onCallDestroySession to be a function.'
        );
      }

      if (!current.authToken) return ctx;

      if (typeof current.requestIp !== 'string') {
        throw new AccountError('InvalidLocationInfoIP');
      }

      if (typeof current.userAgent !== 'string') {
        throw new AccountError('InvalidLocationInfoUserAgent');
      }

      return ctx;
    },
  });

  return {
    onRequest: factory.waterfall() as Waterfall<
      SessionRequest,
      SessionHooksContext
    >,
    onRefreshTokens: factory.waterfall() as unknown as Waterfall<
      SessionRequest & { result: LoginResult },
      SessionHooksContext
    >,
    onUpsertSessionError: factory.waterfall() as unknown as Waterfall<
      Error,
      SessionRequest
    >,
  };
}

export type AccountSessionHooks = ReturnType<typeof createAccountSessionHooks>;

export interface RefreshTokensInput {
  authToken: string; // refreshToken
  request: SessionRequest;
  secret: string;
}