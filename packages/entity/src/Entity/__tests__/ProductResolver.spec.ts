import {
  createResolver,
  createType,
  Darch,
  Infer,
  ObjectType,
} from '@darch/schema';
import { objectMock } from '@darch/schema';
import { createGraphQLSchema } from '@darch/schema/lib/createGraphQLSchema';
import { getTypeName, notNull, PromiseType } from '@darch/utils';
import { slugify } from '@darch/utils/lib/slugify';
import { assert, IsExact } from 'conditional-type-checks';

import { MongoTransporter } from '../../Mongo';
import { AppMock, createAppMock } from '../../Mongo/__tests__/createAppMock';
import { PaginationResult } from '../../Transporter';
import { createEntity, EntityGeneratedFields } from '../Entity';

describe('ProductResolver', () => {
  let mockApp: AppMock;
  let transporter: MongoTransporter;

  beforeEach(async function () {
    await ObjectType.reset();
    mockApp = createAppMock();
    await mockApp.start();
    transporter = new MongoTransporter({
      collection: 'temp1',
      client: mockApp.client!,
    });
  });

  afterEach(async function () {
    await mockApp.reset();
  });

  it('type assertion', async () => {
    const { shape, ProductEntity, productPagination, createOne } = getMocks();

    await expect(
      ProductEntity.findOne({ filter: {}, context: {} })
    ).rejects.toThrow(
      `EMPTY_FILTER ➤ { filter: {}, possibleCondition: undefined, reason: 'EMPTY_FILTER' }`
    );

    await expect(
      ProductEntity.findOne({ filter: { batatas: '123' } as any, context: {} })
    ).rejects.toThrow(`INVALID_FILTER ➤`);

    const res = await createOne();
    expect(res).toEqual(shape);

    type ExpectedArgs = {
      after?: string | undefined;
      filter: {
        id?: string | undefined;
        sku?: string | undefined;
        storeId: string;
      };
      first?: number | undefined;
    };

    type TProduct = Infer<typeof ProductEntity.type>;
    type Args = Parameters<typeof productPagination.resolve>[1];
    assert<IsExact<Args['filter'], ExpectedArgs['filter']>>(true);
    assert<IsExact<Args['first'], ExpectedArgs['first']>>(true);
    assert<IsExact<Args['after'], ExpectedArgs['after']>>(true);

    type Result = PromiseType<ReturnType<typeof productPagination.resolve>>;
    type EntityPagination = PaginationResult<TProduct>;

    assert<EntityPagination extends Result ? true : false>(true);
  });

  test('findById', async function () {
    const { createOne, ProductEntity } = getMocks();
    const created = await createOne();

    const sut = await ProductEntity.findById({
      id: created.id,
      context: {},
    });

    expect(sut).toMatchObject({
      item: {
        id: notNull(created.id),
      },
    });
  });

  test('findMany with only id member', async function () {
    const { createOne, ProductEntity } = getMocks();
    const created = await createOne();

    const sut = await ProductEntity.findMany({
      filter: { storeId: created.storeId },
      context: {},
    });

    expect(sut).toMatchObject({
      items: [
        {
          id: notNull(created.id),
        },
      ],
    });
  });

  test('query edges', async () => {
    const { createOne } = getMocks();
    await createOne();

    const schema = createGraphQLSchema();

    const resp = await Darch.graphql({
      schema,
      contextValue: { userId: () => '123' },
      source:
        '{paginate(filter: { storeId: "123" }) {edges {cursor node{id}} pageInfo {endCursor} }}',
      variableValues: {},
    });

    expect(resp).toEqual({
      data: {
        paginate: {
          edges: [
            {
              cursor: expect.stringMatching('#'),
              node: {
                id: expect.stringMatching('#'),
              },
            },
          ],
          pageInfo: {
            endCursor: expect.stringMatching('#'),
          },
        },
      },
    });
  });

  test('query with condition', async function () {
    const spy = jest.spyOn(transporter, 'paginate');
    const { createOne } = getMocks();
    await createOne();

    const schema = createGraphQLSchema();

    const response = await Darch.graphql({
      schema,
      contextValue: { userId: () => '123' },
      source:
        '{paginate(filter: { storeId: "123" } condition: {id:{ eq: 333 }} ) {edges {cursor node{id}}}}',
      variableValues: {},
    });

    expect(response).toEqual({
      data: {
        paginate: {
          edges: [],
        },
      },
    });

    expect(spy).toBeCalledTimes(1);
    expect(spy).toBeCalledWith(
      expect.objectContaining({
        filter: {
          storeId: '123',
        },
        condition: {
          id: {
            $eq: 333,
          },
        },
      })
    );
    spy.mockRestore();
  });

  test('querying empty result expected', async () => {
    getMocks();

    const schema = createGraphQLSchema();

    const invalidCondition = await Darch.graphql({
      schema,
      contextValue: { userId: () => '123' },
      source:
        '{paginate(filter: { storeId: "123" } condition: {id:{eq: null}}) {edges {cursor node{id}} pageInfo {endCursor} }}',
      variableValues: {},
    });

    expect(invalidCondition).toEqual({
      data: {
        paginate: {
          edges: [],
          pageInfo: {
            endCursor: null,
          },
        },
      },
    });
  });

  test('print schema', () => {
    getMocks();

    const schema = createGraphQLSchema();

    expect(schema.utils.print().split('\n')).toEqual([
      'type Query {',
      '  paginate(after: ID, condition: ProductConditionsInput, filter: paginateInput_filterInput!, first: Int): ProductConnection!',
      '}',
      '',
      'type ProductConnection {',
      '  edges: [Product_Edge]!',
      '  pageInfo: PageInfo!',
      '}',
      '',
      'type Product_Edge {',
      '  cursor: String!',
      '  node: ProductEntity!',
      '}',
      '',
      'type ProductEntity {',
      '  createdAt: Date!',
      '  createdBy: String',
      '  id: String!',
      '  ulid: Ulid!',
      '  updatedAt: Date!',
      '  updatedBy: String',
      '  sku: String!',
      '  storeId: ID!',
      '  title: String!',
      '  shortDescription: String',
      '  brand: String!',
      '  detailsUrl: String',
      '  alcoholic: Boolean!',
      '  thumbUrl: String',
      '  attributes: ProductEntity_attributes',
      '  currentPrice: Float!',
      '  priceFrom: Float',
      '  sellPrice: Float!',
      '  tags: [String]',
      '  slug: String',
      '  categories: [String]!',
      '  spotlight: Boolean',
      '  html: String',
      '}',
      '',
      'scalar Date',
      '',
      'scalar Ulid',
      '',
      'scalar ProductEntity_attributes',
      '',
      'type PageInfo {',
      '  endCursor: String',
      '  hasNextPage: Boolean!',
      '  hasPreviousPage: Boolean!',
      '  startCursor: String',
      '}',
      '',
      'input ProductConditionsInput {',
      '  createdAt: FilterInput',
      '  createdBy: FilterInput',
      '  id: FilterInput',
      '  ulid: FilterInput',
      '  updatedAt: FilterInput',
      '  updatedBy: FilterInput',
      '  sku: FilterInput',
      '  storeId: FilterInput',
      '  title: FilterInput',
      '  shortDescription: FilterInput',
      '  brand: FilterInput',
      '  detailsUrl: FilterInput',
      '  alcoholic: FilterInput',
      '  thumbUrl: FilterInput',
      '  attributes: FilterInput',
      '  currentPrice: FilterInput',
      '  priceFrom: FilterInput',
      '  sellPrice: FilterInput',
      '  tags: FilterInput',
      '  slug: FilterInput',
      '  categories: FilterInput',
      '  spotlight: FilterInput',
      '  html: FilterInput',
      '}',
      '',
      'input FilterInput {',
      '  between: Filter_between',
      '  contains: Filter_contains',
      '  eq: Filter_eq',
      '  exists: Boolean',
      '  gt: Filter_gt',
      '  gte: Filter_gte',
      '  in: [Any]',
      '  lte: Filter_lte',
      '  matchString: String',
      '  ne: Filter_ne',
      '  startsWith: String',
      '  type: Filter_type',
      '}',
      '',
      '"""Union of { list:true, type: string } | { list:true, type: float }"""',
      'scalar Filter_between',
      '',
      '"""',
      'Union of { type: string } | { type: float } | { type: boolean } | { type: null }',
      '"""',
      'scalar Filter_contains',
      '',
      '"""',
      'Union of { type: string } | { type: float } | { type: boolean } | { type: null }',
      '"""',
      'scalar Filter_eq',
      '',
      '"""Union of { type: string } | { type: float }"""',
      'scalar Filter_gt',
      '',
      '"""Union of { type: string } | { type: float }"""',
      'scalar Filter_gte',
      '',
      'scalar Any',
      '',
      '"""Union of { type: string } | { type: float }"""',
      'scalar Filter_lte',
      '',
      '"""',
      'Union of { type: string } | { type: float } | { type: boolean } | { type: null }',
      '"""',
      'scalar Filter_ne',
      '',
      'enum Filter_type {',
      '  String',
      '  Number',
      '  Binary',
      '  Boolean',
      '  Null',
      '  List',
      '  Map',
      '  StringSet',
      '  NumberSet',
      '}',
      '',
      'input paginateInput_filterInput {',
      '  id: ID',
      '  storeId: ID',
      '  sku: String',
      '}',
      '',
      'type Mutation {',
      '  productCreate(sku: String!, storeId: ID!, title: String!, shortDescription: String, brand: String!, detailsUrl: String, alcoholic: Boolean = false, thumbUrl: String, attributes: Product_attributes, currentPrice: Float!, priceFrom: Float, sellPrice: Float!, tags: [String], slug: String, categories: [String]!, spotlight: Boolean, html: String): ProductEntity!',
      '}',
      '',
      'scalar Product_attributes',
    ]);
  });

  function getMocks() {
    const ProductType = createType('Product', {
      object: {
        sku: 'string',
        storeId: 'ID',
        title: 'string',
        shortDescription: 'string?',
        brand: 'string',
        detailsUrl: 'string?',
        alcoholic: { boolean: true, defaultValue: false },
        thumbUrl: 'string?',
        attributes: 'record?',
        currentPrice: 'float',
        priceFrom: 'float?',
        sellPrice: 'float',
        tags: '[string]?',
        slug: 'string?',
        categories: ['string'],
        spotlight: 'boolean?',
        html: 'string?',
      },
    } as const);

    const ProductEntity = createEntity({
      name: 'Product',
      transporter,
      type: ProductType,
      indexes: [
        {
          name: 'byStore',
          field: '_id',
          PK: ['.storeId'],
          SK: ['.sku'],
        },
      ],
    });

    const obj: any = objectMock(ProductEntity.originType._object!.definition);
    const defaultMock = objectMock(EntityGeneratedFields);

    const shape = Object.entries({ ...defaultMock, ...obj }).reduce(
      (acc, [name, val]) => {
        const tn = getTypeName(val);
        const cons = eval(tn);
        return {
          ...acc,
          [name]: expect.any(cons),
        };
      },
      {}
    );

    const productCreateResolver = createResolver({
      type: ProductEntity.type,
      name: 'productCreate',
      kind: 'mutation',
      args: ProductEntity.inputDefinition,
      async resolve(_root, args, context) {
        const storeId = '123';

        const item = {
          ...args,
          storeId,
        };

        item.slug = `${slugify(item.title)}_:${ProductEntity.getDocumentId(
          item
        )}`;

        const result = await ProductEntity.createOne({
          item,
          context,
        });

        if (!result.item) {
          throw new Error('Failed to create product.');
        }

        return result.item;
      },
    });

    type ExpectedArgs = {
      after?: string | undefined;
      filter: {
        id?: string | undefined;
        sku?: string | undefined;
        storeId: string;
      };
      first?: number | undefined;
    };

    const productPagination = createResolver({
      type: ProductEntity.paginationType,
      args: ProductEntity.paginateByStore.queryArgs,
      name: 'paginate',
      async resolve(_, args, context) {
        type Args = typeof args;

        assert<IsExact<Args['filter'], ExpectedArgs['filter']>>(true);
        assert<IsExact<Args['first'], ExpectedArgs['first']>>(true);
        assert<IsExact<Args['after'], ExpectedArgs['after']>>(true);

        return ProductEntity.paginateByStore({ ...args, context });
      },
    });

    function createOne() {
      return productCreateResolver.resolve(
        {},
        obj,
        { userId: () => '123' },
        {} as any
      );
    }

    return {
      ProductEntity,
      obj,
      shape,
      productCreateResolver,
      productPagination,
      createOne,
    };
  }
});