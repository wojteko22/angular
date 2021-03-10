/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as o from '../output/output_ast';

import {Identifiers as R3} from './r3_identifiers';
import {jitOnlyGuardedExpression, R3CompiledExpression, R3Reference} from './util';
import {DefinitionMap} from './view/util';

/**
 * Metadata required by the module compiler to generate a module def (`ɵmod`) for a type.
 */
export interface R3NgModuleMetadata {
  /**
   * An expression representing the module type being compiled.
   */
  type: R3Reference;

  /**
   * An expression representing the module type being compiled, intended for use within a class
   * definition itself.
   *
   * This can differ from the outer `type` if the class is being compiled by ngcc and is inside
   * an IIFE structure that uses a different name internally.
   */
  internalType: o.Expression;

  /**
   * An expression intended for use by statements that are adjacent (i.e. tightly coupled) to but
   * not internal to a class definition.
   *
   * This can differ from the outer `type` if the class is being compiled by ngcc and is inside
   * an IIFE structure that uses a different name internally.
   */
  adjacentType: o.Expression;

  /**
   * An array of expressions representing the bootstrap components specified by the module.
   */
  bootstrap: R3Reference[];

  /**
   * An array of expressions representing the directives and pipes declared by the module.
   */
  declarations: R3Reference[];

  /**
   * An array of expressions representing the imports of the module.
   */
  imports: R3Reference[];

  /**
   * An array of expressions representing the exports of the module.
   */
  exports: R3Reference[];

  /**
   * Whether to emit the selector scope values (declarations, imports, exports) inline into the
   * module definition, or to generate additional statements which patch them on. Inline emission
   * does not allow components to be tree-shaken, but is useful for JIT mode.
   */
  emitInline: boolean;

  /**
   * Whether to generate closure wrappers for bootstrap, declarations, imports, and exports.
   */
  containsForwardDecls: boolean;

  /**
   * The set of schemas that declare elements to be allowed in the NgModule.
   */
  schemas: R3Reference[]|null;

  /** Unique ID or expression representing the unique ID of an NgModule. */
  id: o.Expression|null;
}

/**
 * The shape of the object literal that is passed to the `ɵɵdefineNgModule()` call.
 */
interface R3NgModuleDefMap {
  /**
   * An expression representing the module type being compiled.
   */
  type: o.Expression;
  /**
   * An expression evaluating to an array of expressions representing the bootstrap components
   * specified by the module.
   */
  bootstrap?: o.Expression;
  /**
   * An expression evaluating to an array of expressions representing the directives and pipes
   * declared by the module.
   */
  declarations?: o.Expression;
  /**
   * An expression evaluating to an array of expressions representing the imports of the module.
   */
  imports?: o.Expression;
  /**
   * An expression evaluating to an array of expressions representing the exports of the module.
   */
  exports?: o.Expression;
  /**
   * A literal array expression containing the schemas that declare elements to be allowed in the
   * NgModule.
   */
  schemas?: o.LiteralArrayExpr;
  /**
   * An expression evaluating to the unique ID of an NgModule.
   * */
  id?: o.Expression;
}

/**
 * Construct an `R3NgModuleDef` for the given `R3NgModuleMetadata`.
 */
export function compileNgModule(meta: R3NgModuleMetadata): R3CompiledExpression {
  const {
    internalType,
    type: moduleType,
    bootstrap,
    declarations,
    imports,
    exports,
    schemas,
    containsForwardDecls,
    emitInline,
    id
  } = meta;

  const statements: o.Statement[] = [];
  const definitionMap = new DefinitionMap<R3NgModuleDefMap>();
  definitionMap.set('type', internalType);

  // Only generate the keys in the metadata if the arrays have values.
  if (bootstrap.length) {
    definitionMap.set('bootstrap', refsToArray(bootstrap, containsForwardDecls));
  }

  // If requested to emit scope information inline, pass the declarations, imports and exports to
  // the `ɵɵdefineNgModule` call. The JIT compilation uses this.
  if (emitInline) {
    if (declarations.length) {
      definitionMap.set('declarations', refsToArray(declarations, containsForwardDecls));
    }

    if (imports.length) {
      definitionMap.set('imports', refsToArray(imports, containsForwardDecls));
    }

    if (exports.length) {
      definitionMap.set('exports', refsToArray(exports, containsForwardDecls));
    }
  }

  // If not emitting inline, the scope information is not passed into `ɵɵdefineNgModule` as it would
  // prevent tree-shaking of the declarations, imports and exports references.
  else {
    const setNgModuleScopeCall = generateSetNgModuleScopeCall(meta);
    if (setNgModuleScopeCall !== null) {
      statements.push(setNgModuleScopeCall);
    }
  }

  if (schemas && schemas.length) {
    definitionMap.set('schemas', o.literalArr(schemas.map(ref => ref.value)));
  }

  if (id) {
    definitionMap.set('id', id);
  }

  const expression =
      o.importExpr(R3.defineNgModule).callFn([definitionMap.toLiteralMap()], undefined, true);
  const type = new o.ExpressionType(o.importExpr(R3.NgModuleDefWithMeta, [
    new o.ExpressionType(moduleType.type), tupleTypeOf(declarations), tupleTypeOf(imports),
    tupleTypeOf(exports)
  ]));


  return {expression, type, statements};
}

/**
 * Generates a function call to `ɵɵsetNgModuleScope` with all necessary information so that the
 * transitive module scope can be computed during runtime in JIT mode. This call is marked pure
 * such that the references to declarations, imports and exports may be elided causing these
 * symbols to become tree-shakeable.
 */
function generateSetNgModuleScopeCall(meta: R3NgModuleMetadata): o.Statement|null {
  const {adjacentType: moduleType, declarations, imports, exports, containsForwardDecls} = meta;

  const scopeMap = new DefinitionMap<
      {declarations: o.Expression, imports: o.Expression, exports: o.Expression}>();

  if (declarations.length) {
    scopeMap.set('declarations', refsToArray(declarations, containsForwardDecls));
  }

  if (imports.length) {
    scopeMap.set('imports', refsToArray(imports, containsForwardDecls));
  }

  if (exports.length) {
    scopeMap.set('exports', refsToArray(exports, containsForwardDecls));
  }

  if (Object.keys(scopeMap.values).length === 0) {
    return null;
  }

  // setNgModuleScope(...)
  const fnCall = new o.InvokeFunctionExpr(
      /* fn */ o.importExpr(R3.setNgModuleScope),
      /* args */[moduleType, scopeMap.toLiteralMap()]);

  // (ngJitMode guard) && setNgModuleScope(...)
  const guardedCall = jitOnlyGuardedExpression(fnCall);

  // function() { (ngJitMode guard) && setNgModuleScope(...); }
  const iife = new o.FunctionExpr(
      /* params */[],
      /* statements */[guardedCall.toStmt()]);

  // (function() { (ngJitMode guard) && setNgModuleScope(...); })()
  const iifeCall = new o.InvokeFunctionExpr(
      /* fn */ iife,
      /* args */[]);

  return iifeCall.toStmt();
}

export interface R3InjectorMetadata {
  name: string;
  type: R3Reference;
  internalType: o.Expression;
  providers: o.Expression|null;
  imports: o.Expression[];
}

export function compileInjector(meta: R3InjectorMetadata): R3CompiledExpression {
  const definitionMap = new DefinitionMap<{providers: o.Expression, imports: o.Expression}>();

  if (meta.providers !== null) {
    definitionMap.set('providers', meta.providers);
  }

  if (meta.imports.length > 0) {
    definitionMap.set('imports', o.literalArr(meta.imports));
  }

  const expression =
      o.importExpr(R3.defineInjector).callFn([definitionMap.toLiteralMap()], undefined, true);
  const type =
      new o.ExpressionType(o.importExpr(R3.InjectorDef, [new o.ExpressionType(meta.type.type)]));
  return {expression, type, statements: []};
}

function tupleTypeOf(exp: R3Reference[]): o.Type {
  const types = exp.map(ref => o.typeofExpr(ref.type));
  return exp.length > 0 ? o.expressionType(o.literalArr(types)) : o.NONE_TYPE;
}

function refsToArray(refs: R3Reference[], shouldForwardDeclare: boolean): o.Expression {
  const values = o.literalArr(refs.map(ref => ref.value));
  return shouldForwardDeclare ? o.fn([], [new o.ReturnStatement(values)]) : values;
}
