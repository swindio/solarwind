import { GraphType, ObjectDefinitionInput } from '@backland/schema';
import {
  CommonIndexFields,
  ParsedDocumentIndexes,
  Transporter,
} from '@backland/transporter';
import { GetFieldByDotNotation, Merge } from '@backland/utils';

import { EntityGraphQLConditionsType } from '../EntityFilterConditionType';
import { EntityHooks } from '../EntityPlugin';
import { EntityDocumentBaseDef } from '../defaultFields';
import { EntityIndexRelationConfig } from '../indexRelations/addEntityIndexRelations';
import { EdgeType, PaginationType } from '../paginationUtils';

import { EntityAddRelation } from './AddRelation';
import { EntityTypesContext } from './Context';
import { EntityLoaderMethods } from './EntityLoaderMethods';
import { ExtendEntity } from './ExtendEntity';

export interface EntityFromContext<Context extends EntityTypesContext<any, any>>
  extends EntityLoaderMethods<Context> {
  name: string;

  originType: GraphType<{ object: Context['originDefinition'] }>;

  inputType: GraphType<{
    object: Merge<EntityDocumentBaseDef<true>, Context['originDefinition']>;
  }>;

  usedOptions: Context['options'];

  indexes: Context['indexes'];

  outputDefinition: Context['outputDefinition'];

  type: GraphType<{
    object: Context['outputDefinition'];
  }>;

  addIndexRelation: <E extends unknown, Name extends string>(
    name: Name,
    entity: E
  ) => EntityFromContext<
    EntityTypesContext<
      Omit<Context['originDefinition'], Name> & {
        [L in Name]: { array: { of: GetFieldByDotNotation<E, 'inputType'> } };
      },
      Context['indexes']
    >
  >;

  aliasPaths: string[];

  conditionsDefinition: {
    def: EntityGraphQLConditionsType<Context['originDefinition']>;
    type: 'object';
  };

  databaseType: this['type'];

  edgeType: EdgeType<this['type']>;

  getDocumentId(doc: Record<string, any>): string;

  getIndexFields(doc: Record<string, any>): CommonIndexFields;

  addRelation: EntityAddRelation<this, Context>;

  readonly hasAliases: boolean;

  indexGraphTypes: {
    [K: string]: GraphType<{
      object: ObjectDefinitionInput;
    }>;
  };

  // paths of found aliases in entity schemas or sub schemas
  indexRelations: EntityIndexRelations;

  paginationType: PaginationType<this['type']>;

  parse: (...args: Parameters<this['type']['parse']>) => Context['document'];

  parseDocumentIndexes(doc: Record<string, any>): ParsedDocumentIndexes;

  setOption: <Key extends keyof this['usedOptions'], V>(
    optionName: Key,
    value: V
  ) => this;

  transporter: Transporter | undefined;

  addHooks: (options: (hooks: EntityHooks) => any) => this;

  extend: ExtendEntity<this, Context>;

  hooks: EntityHooks;

  __isEntity: true;
}

export interface EntityIndexRelations {
  [K: string]: EntityIndexRelationConfig;
}

export type _ExtendMethodKeys = 'addHooks' | 'addRelation' | 'extend';

export type _ExcludeExtend<E> = {
  [K in keyof E as K extends _ExtendMethodKeys ? never : K]: E[K];
} & {};

// extendType: <T extends _EntityGraphType>(
//   handler: (
//     helper: ExtendObjectDefinition<this['inputType'], this['inputType']>,
//     originalOptions: this['usedOptions']
//   ) => T
// ) => Entity<
//   T['definition']['def'] extends ObjectDefinitionInput
//     ? T['definition']['def']
//     : {},
//   Indexes
// >;
