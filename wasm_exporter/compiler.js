var assert = require('assert');
var util = require('util');

var types = require('./types');
var instructions = require('./instructions');

function compileExpression(expr, context, out, hints) {
	/* compile the code for evaluating 'expr' into 'out', and return the number of values
	pushed onto the stack; this will usually be 1, but may be 0 if the expression is a void
	function call or its resultIsUsed flag is false. */
	var i, varIndex;

	if (!hints) hints = {};

	if (expr.isCompileTimeConstant) {
		out.push(instructions.Const(
			types.fromCType(expr.type),
			expr.compileTimeConstantValue
		));
		return 1;
	}

	switch (expr.expressionType) {
		case 'AddExpression':
			compileExpression(expr.left, context, out);
			compileExpression(expr.right, context, out);
			if (expr.type.category == 'int') {
				out.push(instructions.Add(types.i32));
			} else if (expr.type.category == 'double') {
				out.push(instructions.Add(types.f64));
			} else {
				throw util.format("Don't know how to handle AddExpressions of type %s", util.inspect(expr.type));
			}
			return 1;
		case 'AddAssignmentExpression':
			assert.equal(expr.left.expressionType, 'VariableExpression');
			assert.equal(expr.type.category, 'int', "Don't know how to handle non-int AddAssignmentExpressions");
			varIndex = context.getIndex(expr.left.variable.id);
			if (varIndex === null) {
				throw util.format("Variable not found: %s", util.inspect(expr.left.variable));
			}
			if (expr.left.variable.isGlobal) {
				out.push(instructions.GetGlobal(varIndex));
				compileExpression(expr.right, context, out);
				out.push(instructions.Add(types.i32));
				if (!expr.resultIsUsed && hints.canDiscardResult) {
					out.push(instructions.SetGlobal(varIndex));
					return 0;
				} else {
					out.push(instructions.SetGlobal(varIndex));
					out.push(instructions.GetGlobal(varIndex));
					return 1;
				}
			} else {
				out.push(instructions.GetLocal(varIndex));
				compileExpression(expr.right, context, out);
				out.push(instructions.Add(types.i32));
				if (!expr.resultIsUsed && hints.canDiscardResult) {
					out.push(instructions.SetLocal(varIndex));
					return 0;
				} else {
					out.push(instructions.TeeLocal(varIndex));
					return 1;
				}
			}
			break;
		case 'AssignmentExpression':
			/* semantics of an assignment expression depend on the expression type of the lvalue */
			switch (expr.left.expressionType) {
				case 'VariableExpression':
					varIndex = context.getIndex(expr.left.variable.id);
					if (varIndex === null) {
						throw util.format("Variable not found: %s", util.inspect(expr.left.variable));
					}
					compileExpression(expr.right, context, out);
					castResult(expr.right.type, expr.left.type, out);
					if (expr.left.variable.isGlobal) {
						if (!expr.resultIsUsed && hints.canDiscardResult) {
							out.push(instructions.SetGlobal(varIndex));
							return 0;
						} else {
							out.push(instructions.SetGlobal(varIndex));
							out.push(instructions.GetGlobal(varIndex));
							return 1;
						}
					} else {
						if (!expr.resultIsUsed && hints.canDiscardResult) {
							out.push(instructions.SetLocal(varIndex));
							return 0;
						} else {
							out.push(instructions.TeeLocal(varIndex));
							return 1;
						}
					}
					break;
				case 'DereferenceExpression':
					compileExpression(expr.left.argument, context, out);
					compileExpression(expr.right, context, out);
					castResult(expr.right.type, expr.left.type, out);
					if (!expr.resultIsUsed && hints.canDiscardResult) {
						out.push(instructions.Store(types.fromCType(expr.left.type), null, null));
						return 0;
					} else {
						throw("Pointer assignment where the result is used is not currently supported");
					}
					break;
				default:
					throw("Don't know how to handle an AssignmentExpression with an lvalue of type " + expr.left.expressionType);
			}
			break;
		case 'CommaExpression':
			var pushCount = compileExpression(expr.left, context, out, {
				canDiscardResult: true
			});
			/* drop any results that were pushed */
			for (j = 0; j < pushCount; j++) {
				out.push(instructions.Drop);
			}
			return compileExpression(expr.right, context, out, hints);
		case 'ConditionalExpression':
			compileExpression(expr.test, context, out);
			out.push(instructions.If(types.fromCType(expr.type)));
			compileExpression(expr.consequent, context, out);
			out.push(instructions.Else);
			compileExpression(expr.alternate, context, out);
			out.push(instructions.End);
			return 1;
		case 'DereferenceExpression':
			compileExpression(expr.argument, context, out);
			out.push(instructions.Load(types.fromCType(expr.type), null, null));
			return 1;
		case 'DivideExpression':
			compileExpression(expr.left, context, out);
			compileExpression(expr.right, context, out);
			if (expr.type.category == 'int') {
				out.push(instructions.DivS(types.i32));
			} else if (expr.type.category == 'double') {
				out.push(instructions.Div(types.f64));
			} else {
				throw util.format("Don't know how to handle DivideExpressions of type %s", util.inspect(expr.type));
			}
			return 1;
		case 'EqualExpression':
			compileExpression(expr.left, context, out);
			compileExpression(expr.right, context, out);
			if (expr.left.type.category == 'int' && expr.right.type.category == 'int') {
				out.push(instructions.Eq(types.i32));
			} else if (expr.left.type.category == 'double' && expr.right.type.category == 'double') {
				out.push(instructions.Eq(types.f64));
			} else {
				throw util.format("Don't know how to handle EqualExpressions of types: %s, %s",
					util.inspect(expr.left.type), util.inspect(expr.right.type)
				);
			}
			return 1;
		case 'FunctionCallExpression':
			assert.equal(expr.callee.expressionType, 'VariableExpression');
			var functionVariable = expr.callee.variable;
			var functionIndex = context.globalContext.getFunctionIndex(functionVariable.id);
			if (functionIndex === null) {
				throw util.format("Function not found: %s", util.inspect(functionVariable));
			}
			for (i = 0; i < expr.parameters.length; i++) {
				compileExpression(expr.parameters[i], context, out);
			}
			out.push(instructions.Call(functionIndex));
			return (functionVariable.type.returnType.category == 'void') ? 0 : 1;
		case 'GreaterThanExpression':
			compileExpression(expr.left, context, out);
			compileExpression(expr.right, context, out);
			if (expr.left.type.category == 'int' && expr.right.type.category == 'int') {
				out.push(instructions.GtS(types.i32));
			} else if (expr.left.type.category == 'double' && expr.right.type.category == 'double') {
				out.push(instructions.Gt(types.f64));
			} else {
				throw util.format("Don't know how to handle GreaterThanExpressions of types: %s, %s",
					util.inspect(expr.left.type), util.inspect(expr.right.type)
				);
			}
			return 1;
		case 'GreaterThanOrEqualExpression':
			compileExpression(expr.left, context, out);
			compileExpression(expr.right, context, out);
			if (expr.left.type.category == 'int' && expr.right.type.category == 'int') {
				out.push(instructions.GeS(types.i32));
			} else if (expr.left.type.category == 'double' && expr.right.type.category == 'double') {
				out.push(instructions.Ge(types.f64));
			} else {
				throw util.format("Don't know how to handle GreaterThanOrEqualExpressions of types: %s, %s",
					util.inspect(expr.left.type), util.inspect(expr.right.type)
				);
			}
			return 1;
		case 'LessThanExpression':
			compileExpression(expr.left, context, out);
			compileExpression(expr.right, context, out);
			if (expr.left.type.category == 'int' && expr.right.type.category == 'int') {
				out.push(instructions.LtS(types.i32));
			} else if (expr.left.type.category == 'double' && expr.right.type.category == 'double') {
				out.push(instructions.Lt(types.f64));
			} else {
				throw util.format("Don't know how to handle LessThanExpressions of types: %s, %s",
					util.inspect(expr.left.type), util.inspect(expr.right.type)
				);
			}
			return 1;
		case 'LessThanOrEqualExpression':
			compileExpression(expr.left, context, out);
			compileExpression(expr.right, context, out);
			if (expr.left.type.category == 'int' && expr.right.type.category == 'int') {
				out.push(instructions.LeS(types.i32));
			} else if (expr.left.type.category == 'double' && expr.right.type.category == 'double') {
				out.push(instructions.Le(types.f64));
			} else {
				throw util.format("Don't know how to handle LessThanOrEqualExpressions of types: %s, %s",
					util.inspect(expr.left.type), util.inspect(expr.right.type)
				);
			}
			return 1;
		case 'LogicalAndExpression':
			/* left && right compiles to:
			left
			if (result i32)
				right
				i32.eqz
				i32.eqz
			else
				i32.const 0
			end
			get_local result
			*/
			assert.equal(expr.left.type.category, 'int');
			assert.equal(expr.right.type.category, 'int');

			compileExpression(expr.left, context, out);
			out.push(instructions.If(types.i32));
			compileExpression(expr.right, context, out);
			out.push(instructions.Eqz(types.i32));
			out.push(instructions.Eqz(types.i32));
			out.push(instructions.Else);
			out.push(instructions.Const(types.i32, 0));
			out.push(instructions.End);
			return 1;
		case 'LogicalNotExpression':
			assert.equal(expr.argument.type.category, 'int', "Don't know how to handle non-int LogicalNotExpressions");
			compileExpression(expr.argument, context, out);
			/* logical not is equivalent to 'equals zero' */
			out.push(instructions.Eqz(types.i32));
			return 1;
		case 'LogicalOrExpression':
			/* left || right compiles to: 
			left
			if (result i32)
				const 1
			else
				right
				eqz
				eqz
			end
			*/
			assert.equal(expr.left.type.category, 'int');
			assert.equal(expr.right.type.category, 'int');

			compileExpression(expr.left, context, out);
			out.push(instructions.If(types.i32));
			out.push(instructions.Const(types.i32, 1));
			out.push(instructions.Else);
			compileExpression(expr.right, context, out);
			out.push(instructions.Eqz(types.i32));
			out.push(instructions.Eqz(types.i32));
			out.push(instructions.End);
			return 1;
		case 'ModExpression':
			compileExpression(expr.left, context, out);
			compileExpression(expr.right, context, out);
			if (expr.type.category == 'int') {
				out.push(instructions.RemS(types.i32));
			} else {
				throw util.format("Don't know how to handle ModExpressions of type %s", util.inspect(expr.type));
			}
			return 1;
		case 'MultiplyExpression':
			compileExpression(expr.left, context, out);
			compileExpression(expr.right, context, out);
			if (expr.type.category == 'int') {
				out.push(instructions.Mul(types.i32));
			} else if (expr.type.category == 'double') {
				out.push(instructions.Mul(types.f64));
			} else {
				throw util.format("Don't know how to handle MultiplyExpressions of type %s", util.inspect(expr.type));
			}
			return 1;
		case 'NotEqualExpression':
			compileExpression(expr.left, context, out);
			compileExpression(expr.right, context, out);
			if (expr.left.type.category == 'int' && expr.right.type.category == 'int') {
				out.push(instructions.Ne(types.i32));
			} else if (expr.left.type.category == 'double' && expr.right.type.category == 'double') {
				out.push(instructions.Ne(types.f64));
			} else {
				throw util.format("Don't know how to handle NotEqualExpressions of types: %s, %s",
					util.inspect(expr.left.type), util.inspect(expr.right.type)
				);
			}
			return 1;
		case 'PostdecrementExpression':
			assert.equal(expr.type.category, 'int', "Don't know how to handle non-int PostdecrementExpression");
			assert.equal(expr.argument.expressionType, 'VariableExpression');
			varIndex = context.getIndex(expr.argument.variable.id);
			if (varIndex === null) {
				throw util.format("Variable not found: %s", util.inspect(expr.argument.variable));
			}
			if (expr.argument.variable.isGlobal) {
				if (!expr.resultIsUsed && hints.canDiscardResult) {
					out.push(instructions.GetGlobal(varIndex));
					out.push(instructions.Const(types.i32, 1));
					out.push(instructions.Sub(types.i32));
					out.push(instructions.SetGlobal(varIndex));
					return 0;
				} else {
					out.push(instructions.GetGlobal(varIndex));
					out.push(instructions.GetGlobal(varIndex));
					out.push(instructions.Const(types.i32, 1));
					out.push(instructions.Sub(types.i32));
					out.push(instructions.SetGlobal(varIndex));
					return 1;
				}
			} else {
				if (!expr.resultIsUsed && hints.canDiscardResult) {
					out.push(instructions.GetLocal(varIndex));
					out.push(instructions.Const(types.i32, 1));
					out.push(instructions.Sub(types.i32));
					out.push(instructions.SetLocal(varIndex));
					return 0;
				} else {
					out.push(instructions.GetLocal(varIndex));
					out.push(instructions.GetLocal(varIndex));
					out.push(instructions.Const(types.i32, 1));
					out.push(instructions.Sub(types.i32));
					out.push(instructions.SetLocal(varIndex));
					return 1;
				}
			}
			break;
		case 'PostincrementExpression':
			assert.equal(expr.type.category, 'int', "Don't know how to handle non-int PostincrementExpression");
			assert.equal(expr.argument.expressionType, 'VariableExpression');
			varIndex = context.getIndex(expr.argument.variable.id);
			if (varIndex === null) {
				throw util.format("Variable not found: %s", util.inspect(expr.argument.variable));
			}
			if (expr.argument.variable.isGlobal) {
				if (!expr.resultIsUsed && hints.canDiscardResult) {
					out.push(instructions.GetGlobal(varIndex));
					out.push(instructions.Const(types.i32, 1));
					out.push(instructions.Add(types.i32));
					out.push(instructions.SetGlobal(varIndex));
					return 0;
				} else {
					out.push(instructions.GetGlobal(varIndex));
					out.push(instructions.GetGlobal(varIndex));
					out.push(instructions.Const(types.i32, 1));
					out.push(instructions.Add(types.i32));
					out.push(instructions.SetGlobal(varIndex));
					return 1;
				}
			} else {
				if (!expr.resultIsUsed && hints.canDiscardResult) {
					out.push(instructions.GetLocal(varIndex));
					out.push(instructions.Const(types.i32, 1));
					out.push(instructions.Add(types.i32));
					out.push(instructions.SetLocal(varIndex));
					return 0;
				} else {
					out.push(instructions.GetLocal(varIndex));
					out.push(instructions.GetLocal(varIndex));
					out.push(instructions.Const(types.i32, 1));
					out.push(instructions.Add(types.i32));
					out.push(instructions.SetLocal(varIndex));
					return 1;
				}
			}
			break;
		case 'ShiftLeftExpression':
			compileExpression(expr.left, context, out);
			compileExpression(expr.right, context, out);
			if (expr.type.category == 'int') {
				out.push(instructions.Shl(types.i32));
			} else {
				throw util.format("Don't know how to handle ShiftLeftExpression of type %s", util.inspect(expr.type));
			}
			return 1;
		case 'ShiftRightExpression':
			compileExpression(expr.left, context, out);
			compileExpression(expr.right, context, out);
			if (expr.type.category == 'int') {
				out.push(instructions.ShrS(types.i32));
			} else {
				throw util.format("Don't know how to handle ShiftRightExpression of type %s", util.inspect(expr.type));
			}
			return 1;
		case 'SubtractExpression':
			compileExpression(expr.left, context, out);
			compileExpression(expr.right, context, out);
			if (expr.type.category == 'int') {
				out.push(instructions.Sub(types.i32));
			} else if (expr.type.category == 'double') {
				out.push(instructions.Sub(types.f64));
			} else {
				throw util.format("Don't know how to handle SubtractExpressions of type %s", util.inspect(expr.type));
			}
			return 1;
		case 'SubtractAssignmentExpression':
			assert.equal(expr.left.expressionType, 'VariableExpression');
			assert.equal(expr.type.category, 'int', "Don't know how to handle non-int SubtractAssignmentExpressions");
			varIndex = context.getIndex(expr.left.variable.id);
			if (varIndex === null) {
				throw util.format("Variable not found: %s", util.inspect(expr.left.variable));
			}
			if (expr.left.variable.isGlobal) {
				out.push(instructions.GetGlobal(varIndex));
				compileExpression(expr.right, context, out);
				out.push(instructions.Sub(types.i32));
				if (!expr.resultIsUsed && hints.canDiscardResult) {
					out.push(instructions.SetGlobal(varIndex));
					return 0;
				} else {
					out.push(instructions.SetGlobal(varIndex));
					out.push(instructions.GetGlobal(varIndex));
					return 1;
				}
			} else {
				out.push(instructions.GetLocal(varIndex));
				compileExpression(expr.right, context, out);
				out.push(instructions.Sub(types.i32));
				if (!expr.resultIsUsed && hints.canDiscardResult) {
					out.push(instructions.SetLocal(varIndex));
					return 0;
				} else {
					out.push(instructions.TeeLocal(varIndex));
					return 1;
				}
			}
			break;
		case 'VariableExpression':
			varIndex = context.getIndex(expr.variable.id);
			if (varIndex === null) {
				throw util.format("Variable not found: %s", util.inspect(expr.variable));
			}
			if (expr.variable.isGlobal) {
				out.push(instructions.GetGlobal(varIndex));
			} else {
				out.push(instructions.GetLocal(varIndex));
			}
			return 1;
		default:
			throw util.format(
				"Unrecognised expression type %s: %s",
				expr.expressionType,
				util.inspect(expr)
			);
	}
}

function castResult(fromType, toType, out) {
	if (fromType.category == 'int' && toType.category == 'int') {
		// no cast necessary
	} else if (fromType.category == 'double' && toType.category == 'double') {
		// no cast necessary
	} else if (fromType.category == 'double' && toType.category == 'int') {
		out.push(instructions.TruncS(types.f64, types.i32));
	} else {
		throw util.format(
			"Don't know how to cast result from %s to %s", util.inspect(fromType), util.inspect(toType)
		);
	}
}

function compileStatement(statement, context, out, breakDepth, continueDepth) {
	var j, pushCount;

	switch(statement.statementType) {
		case 'BlockStatement':
			compile(statement.statements, context, out, breakDepth, continueDepth);
			break;
		case 'BreakStatement':
			assert(breakDepth !== null);
			out.push(instructions.Br(breakDepth));
			break;
		case 'ContinueStatement':
			assert(continueDepth !== null);
			out.push(instructions.Br(continueDepth));
			break;
		case 'DeclarationStatement':
			for (j = 0; j < statement.variableDeclarations.length; j++) {
				var variableDeclaration = statement.variableDeclarations[j];
				var variable = variableDeclaration.variable;
				var index = context.declareVariable(variable.id, types.fromCType(variable.type), null);
				if (variableDeclaration.initialValueExpression !== null) {
					compileExpression(variableDeclaration.initialValueExpression, context, out);
					castResult(variableDeclaration.initialValueExpression.type, variable.type, out);
					out.push(instructions.SetLocal(index));
				}
			}
			break;
		case 'DoWhileStatement':
			/*
			do {stuff} while (condition); compiles to:

			block
				loop
					block
						stuff
						; continue needs br 0
						; break needs br 2
					end
					condition
					if
						br 1
					end
				end
			end
			*/
			out.push(instructions.Block());
			out.push(instructions.Loop());
			out.push(instructions.Block());
			compileStatement(statement.body, context, out, 2, 0);
			out.push(instructions.End);
			compileExpression(statement.condition, context, out);
			out.push(instructions.If());
			out.push(instructions.Br(1));
			out.push(instructions.End);
			out.push(instructions.End);
			out.push(instructions.End);
			break;
		case 'ExpressionStatement':
			pushCount = compileExpression(statement.expression, context, out, {
				canDiscardResult: true
			});
			/* drop any results that were pushed */
			for (j = 0; j < pushCount; j++) {
				out.push(instructions.Drop);
			}
			break;
		case 'ForStatement':
			/*
			'for (init; test; update) do_stuff' compiles to:

			init
			block  ; required for 'break'
				loop
					test
					if
						block ; required for 'continue'
							do_stuff
							; break statements here need 'br 3'
							; continue statements here need 'br 0'
						end
						update
						br 1  ; repeat loop
					end
				end
			end

			'for (init; ; update) do_stuff' compiles to:
			init
			block  ; only required for 'break'
				loop
					block ; required for 'continue'
						do_stuff
						; break statements here need 'br 2'
						; continue statements here need 'br 0'
					end
					update
					br 0  ; repeat loop
				end
			end
			*/
			compileStatement(statement.init, context, out, null, null);
			out.push(instructions.Block());
			out.push(instructions.Loop());
			if (statement.test) {
				compileExpression(statement.test, context, out);
				out.push(instructions.If());
				out.push(instructions.Block());
				compileStatement(statement.body, context, out, 3, 0);
				out.push(instructions.End);

				if (statement.update) {
					pushCount = compileExpression(statement.update, context, out, {
						canDiscardResult: true
					});
					/* drop any results that were pushed */
					for (j = 0; j < pushCount; j++) {
						out.push(instructions.Drop);
					}
				}

				out.push(instructions.Br(1));
				out.push(instructions.End);
			} else {
				out.push(instructions.Block());
				compileStatement(statement.body, context, out, 2, 0);
				out.push(instructions.End);

				if (statement.update) {
					pushCount = compileExpression(statement.update, context, out, {
						canDiscardResult: true
					});
					/* drop any results that were pushed */
					for (j = 0; j < pushCount; j++) {
						out.push(instructions.Drop);
					}
				}

				out.push(instructions.Br(0));
			}
			out.push(instructions.End);
			out.push(instructions.End);
			break;
		case 'IfStatement':
			compileExpression(statement.test, context, out);
			out.push(instructions.If());
			var innerBreakDepth = (breakDepth === null ? null : breakDepth + 1);
			var innerContinueDepth = (continueDepth === null ? null : continueDepth + 1);
			compileStatement(statement.thenStatement, context, out, innerBreakDepth, innerContinueDepth);
			if (statement.elseStatement) {
				out.push(instructions.Else);
				compileStatement(statement.elseStatement, context, out, innerBreakDepth, innerContinueDepth);
			}
			out.push(instructions.End);
			break;
		case 'NullStatement':
			break;
		case 'ReturnStatement':
			if (statement.expression !== null) {
				compileExpression(statement.expression, context, out);
				castResult(statement.expression.type, statement.returnType, out);
			}
			/* TODO: omit the 'return' when it's the final statement */
			out.push(instructions.Return);
			break;
		case 'WhileStatement':
			/*
			'while (condition) do_stuff' compiles to:

			block
				loop
					condition
					if
						do_stuff
						; break statements here need 'br 2'
						; continue statements here need 'br 1'
						br 1  ; repeat loop
					end
				end
			end
			*/

			out.push(instructions.Block());
			out.push(instructions.Loop());
			compileExpression(statement.condition, context, out);
			out.push(instructions.If());
			compileStatement(statement.body, context, out, 2, 1);
			out.push(instructions.Br(1));
			out.push(instructions.End);
			out.push(instructions.End);
			out.push(instructions.End);
			break;
		default:
			throw util.format(
				"Unrecognised statement type %s: %s",
				statement.statementType,
				util.inspect(statement)
			);
	}
}

function compile(body, context, out, breakDepth, continueDepth) {
	for (var i = 0; i < body.length; i++) {
		compileStatement(body[i], context, out, breakDepth, continueDepth);
	}
}

exports.compile = compile;
