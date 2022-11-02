import {
  ExtendDefinitionResult,
  GraphType,
  LazyParseGraphTypePayload,
  ObjectDefinitionInput,
  ObjectFieldInput,
  parseObjectDefinition,
  ToFinalField,
} from '@backland/schema';
import {
  CollectionConfigIndexes,
  CreateOneResult,
  DocumentBase,
  DocumentMethods,
  LoaderContext,
  ParsedDocumentIndexes,
  ParsedIndexKey,
  Transporter,
  TransporterLoaderName,
  TransporterLoadersRecord,
} from '@backland/transporter';
import { MaybeArray, Merge, UnionToIntersection } from '@backland/utils';

import {
  EntityGraphQLConditionsType,
  EntityGraphQLFieldConditionsType,
} from './EntityFilterConditionType';
import {
  _EntityGraphType,
  EntityDocFromType,
  EntityFieldResolver,
  EntityOptions,
} from './EntityOptions';
import { EntityHookOptions, EntityHooks } from './EntityPlugin';
import { EntityOperationInfosRecord } from './entityOperationContextTypes';
import {
  AddIndexRelationsFn,
  EntityIndexRelationsRecord,
} from './indexRelations';
import { EdgeType, PaginationType } from './paginationUtils';

export type EntityGeneratedFields = ReturnType<
  typeof createEntityDefaultFields
>;

export type _Cast<A1 extends any, A2 extends any> = A1 extends A2 ? A1 : A2;

export const createEntityDefaultFields = () =>
  _EntityGeneratedFields({
    _v: {
      hidden: true,
      ulid: { autoCreate: true },
    },
    createdAt: { type: 'date' },
    createdBy: {
      optional: true,
      type: 'string',
    },
    id: { type: 'string' },
    ulid: { type: 'ulid' },
    updatedAt: { type: 'date' },
    updatedBy: {
      optional: true,
      type: 'string',
    },
  });

type GetLoaderFilterDef<Loader, DocDef> = Loader extends (
  config: infer Config
) => any
  ? Config extends { filter: infer Filter }
    ? UnionToIntersection<Filter> extends infer AllFilter
      ? {
          [K in keyof AllFilter as K extends keyof DocDef
            ? K
            : never]: K extends keyof DocDef ? DocDef[K] : never;
        } extends infer R
        ? {
            // transforming optional args as optional field definitions
            [K in keyof R]-?: [Extract<R[K], undefined>] extends [never]
              ? ToFinalField<R[K]>
              : Omit<
                  ToFinalField<Exclude<R[K], undefined>>,
                  '__infer' | 'optional'
                > & { optional: true } extends infer F
              ? { [K in keyof F]: F[K] } & {}
              : never;
          }
        : never
      : never
    : never
  : never;

export type EntityDefaultFields = {
  _v: string;
  createdAt: Date;
  createdBy: string | undefined;
  id: string;
  ulid: string;
  updatedAt: Date;
  updatedBy: string | undefined;
};

export type EntityFinalDefinition<InputDef> = InputDef extends {
  definition: { def: infer Definition };
}
  ? {
      [K in keyof EntityGeneratedFields as K extends keyof Definition
        ? never
        : K]: EntityGeneratedFields[K];
    } & {
      [K in keyof Definition]: Definition[K];
    } extends infer R
    ? {
        [K in keyof R]: R[K];
      }
    : never
  : never;

type _Entity<Options extends EntityOptions> = {
  __isBLEntity: true;

  _hooks: EntityHooks;
  addIndexRelations: AddIndexRelationsFn<Options>;

  aliasPaths: string[];

  clone: <O extends EntityOptions>(
    handler: ((originalOptions: Options) => O) | Partial<O>
  ) => Entity<O>;

  conditionsDefinition: {
    def: EntityGraphQLConditionsType<_getOptionsTypeDef<Options>>;
    type: 'object';
  };

  databaseType: ((x: Options['type']) => any) extends (x: infer Type) => any
    ? GraphType<{ object: EntityFinalDefinition<Type> }>
    : never;

  edgeType: EdgeType<Options['type']>;

  extendType: <T extends _EntityGraphType>(
    handler: (
      helper: ExtendDefinitionResult<Options['type'], Options['type']>,
      originalOptions: Options
    ) => T
  ) => Entity<{ [K in keyof Options]: K extends 'type' ? T : Options[K] } & {}>;

  getDocumentId(doc: Record<string, any>): string;

  readonly hasAliases: boolean;

  indexGraphTypes: {
    [K in Options['indexes'][number]['name']]: GraphType<{
      object: ObjectDefinitionInput;
    }>;
  };

  // paths of found aliases in entity schemas or sub schemas
  indexRelations: EntityIndexRelationsRecord;

  indexes: Options['indexes'];

  inputDefinition: Options['type'] extends { definition: infer Def }
    ? Def extends { def: infer Def }
      ? {
          [K in keyof Def]: ToFinalField<Def[K]>;
        }
      : never
    : never;

  name: Options['name'];

  originType: Options['type'];

  paginationType: PaginationType<Options['type']>;

  parse: (
    ...args: Parameters<Options['type']['parse']>
  ) => EntityDocFromType<Options['type']>;

  parseDocumentIndexes(doc: Record<string, any>): ParsedDocumentIndexes;

  setOption: <ON extends keyof EntityOptions, NV extends EntityOptions[ON]>(
    optionName: ON,
    value: NV
  ) => Entity<
    _Cast<
      { [K in keyof Options]: K extends ON ? NV : Options[K] },
      EntityOptions
    >
  >;

  transporter: Options['transporter'];

  type: ((x: Options['type']) => any) extends (x: infer Type) => any
    ? GraphType<{ object: EntityFinalDefinition<Type> }>
    : never;

  updateDefinition: ((x: Options['type']) => any) extends (x: infer Type) => any
    ? Type extends { definition: { def: infer D } }
      ? {
          [K in keyof D]: ToFinalField<D[K]> extends infer R
            ? {
                [K in keyof R as K extends '__infer'
                  ? never
                  : K]: K extends 'optional' ? true : R[K];
              }
            : never;
        }
      : never
    : never;

  usedOptions: Options;
} & { createOne: _EntityCreateOne<Options> } & UnionToIntersection<
    {
      // METHODS WITH FILTER BY INDEX
      [IndexKey in _key<Options['indexes']>]: {
        [L in IndexKey]: MethodsWithIndexBasedFilter<
          _getDocType<Options>,
          _get<Options['indexes'], L>
        > extends infer Loaders
          ? { [K in keyof Loaders]: Loaders[K] & Utils<Loaders[K], Options> }
          : any;
      }[IndexKey];
    }[_key<Options['indexes']>]
  >;

export type Entity<Options extends EntityOptions> =
  //
  _Entity<Options> & WithExtend<Options, _Entity<Options>>;

type Utils<Loader, Options extends EntityOptions> = {
  filterDef: GetLoaderFilterDef<Loader, _getOptionsTypeDef<Options>>;
  queryArgs: {
    after: {
      optional: true;
      type: 'ID';
    };
    condition: {
      def: EntityGraphQLFieldConditionsType<_getOptionsTypeDef<Options>>;
      optional: true;
      type: 'object';
    };
    filter: {
      def: GetLoaderFilterDef<Loader, _getOptionsTypeDef<Options>>;
      type: 'object';
    };
    first: {
      optional: true;
      type: 'int';
    };
  };
};

export type _EntityCreateOne<Options extends EntityOptions> =
  EntityTransporterMethod<
    DocumentMethods<
      //
      // Doc with DefaultEntityFields as optional
      {
        [K in keyof _getDocType<Options> as K extends keyof EntityDefaultFields
          ? never
          : K]: _getDocType<Options>[K];
      } & {
        [K in keyof _getDocType<Options> as K extends keyof EntityDefaultFields
          ? K
          : never]?: _getDocType<Options>[K];
      },
      GetFieldsUsedInIndexes<Options['indexes'][number], 'PK'>,
      GetFieldsUsedInIndexes<Options['indexes'][number], 'SK'>
    >['createOne'] extends infer CreateOne
      ? CreateOne extends (config: infer Config) => any
        ? (config: Config) => Promise<CreateOneResult<_getDocType<Options>>>
        : never
      : never
  >;

type _get<LIST, K> = K extends keyof LIST ? LIST[K] : any;
type _key<T> = Exclude<keyof T, keyof any[]>;

type _getDocType<Options extends EntityOptions> = EntityDocFromType<
  Options['type']
>;

type _getOptionsTypeDef<Options extends EntityOptions> =
  Options['type'] extends {
    definition: infer Def;
  }
    ? Def extends { def: infer Def }
      ? Def
      : any
    : any;

type ExtendMethodKeys = 'addHooks' | 'addRelations' | 'extend';

type ExcludeExtend<E> = {
  [K in keyof E as K extends ExtendMethodKeys ? never : K]: E[K];
} & {};

type WithExtend<Options extends EntityOptions, Origin> = {
  addHooks: (
    options: MaybeArray<EntityHookOptions>
  ) => ExcludeExtend<Origin> & WithExtend<Options, ExcludeExtend<Origin>>;

  addRelations: <
    Context extends LoaderContext,
    Definition extends ObjectFieldInput,
    ArgsDef extends ObjectDefinitionInput | undefined
  >(
    options: EntityFieldResolver<
      Context,
      Definition,
      ArgsDef,
      _getDocType<Options>
    >
  ) => ExcludeExtend<Origin> & WithExtend<Options, ExcludeExtend<Origin>>;

  extend: <TransformerReturn>(
    transformer: (
      current: ExcludeExtend<Origin> &
        WithExtend<Options, ExcludeExtend<Origin>>,
      utils: {
        extend: <V>(value: V) => ExtendDefinitionResult<V, V>;
      }
    ) => TransformerReturn
  ) => {
    [K in
      | keyof TransformerReturn
      | keyof Origin]: K extends keyof TransformerReturn
      ? TransformerReturn[K]
      : K extends keyof Origin
      ? Origin[K]
      : never;
  };
};

export type EntityOperationInfoContext<
  LoaderName extends TransporterLoaderName = TransporterLoaderName
> = EntityOperationInfosRecord[LoaderName];

export function isEntityContextOfLoader<
  LoaderName extends TransporterLoaderName
>(
  t: EntityOperationInfoContext,
  name: LoaderName
): t is EntityOperationInfoContext<LoaderName> {
  return t.loaderName === name;
}

type GetFieldsUsedInIndexes<IndexItem, Kind> = Kind extends keyof IndexItem
  ? IndexItem[Kind] extends Array<infer F> | ReadonlyArray<infer F>
    ? F extends `.${infer Field}`
      ? Field
      : never
    : never
  : never;

export type EntityLoaderConfig<
  Method extends TransporterLoaderName,
  Context extends LoaderContext = Record<string, any>
> = TransporterLoadersRecord[Method] extends (config: infer Config) => any
  ? Config & { context: Context } extends infer R
    ? {
        [K in keyof R as K extends 'context' ? never : K]: R[K];
      } & { context: Context }
    : never
  : any;

type EntityTransporterMethod<
  Method,
  Context extends LoaderContext = Record<string, any>
> = Method extends (config: infer Config) => infer Result
  ? ((
      config: Config & { context: Context } extends infer R
        ? {
            [K in keyof R as K extends 'context' ? never : K]: R[K];
          } & { context: Context }
        : never
    ) => Result) & {
      indexInfo: [ParsedIndexKey, ...ParsedIndexKey[]];
    }
  : never;

export type MethodsWithIndexBasedFilter<
  Document extends DocumentBase,
  IndexItem
> = {
  //  CREATE_ONE IS EXCLUDED because there is no filters
  [M in keyof DocumentMethods<any, any, any> as M extends `createOne`
    ? never
    : M]: EntityTransporterMethod<
    DocumentMethods<
      Document,
      GetFieldsUsedInIndexes<IndexItem, 'PK'>,
      GetFieldsUsedInIndexes<IndexItem, 'SK'>
    >[M],
    LoaderContext
  >;
};

function _EntityGeneratedFields<
  T extends { [K in keyof EntityDefaultFields]: ObjectFieldInput }
>(
  input: T
): {
  [K in keyof T]: {
    [S in keyof ToFinalField<T[K]> as S extends '__infer'
      ? never
      : S]: ToFinalField<T[K]>[S];
  } & {};
} {
  return parseObjectDefinition(input).definition as any;
}

export type EntityDocument<Document> = Merge<Document, EntityDefaultFields>;

export type AnyEntityDocument<Doc extends DocumentBase = DocumentBase> =
  EntityDocument<Doc>;

export type AnyEntity<
  Doc extends DocumentBase = DocumentBase,
  PK extends keyof Doc = keyof Doc,
  SK extends keyof Doc | undefined = undefined
> = Entity<{
  indexes: CollectionConfigIndexes<
    { [K in PK]: Doc[PK] } & (SK extends string ? { [K in SK]: Doc[SK] } : {})
  >;
  name: string;
  transporter: Transporter;
  type: {
    __lazyGetter: LazyParseGraphTypePayload;
    definition: any;
    parse(...args: any[]): Doc;
  };
}>;
