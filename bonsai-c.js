var fs = require("fs");
var util = require('util');

var parser = require("./c_parser/parser").parser;
parser.yy = require("./c_parser/syntax_tree");

var abstractor = require("./abstractor/abstractor");
var asmJsExporter = require("./asm_js_exporter/asm_js_exporter");
var escodegen = require('escodegen');

var WasmModule = require("./wasm_exporter/wasm_module").WasmModule;

exports.compile = function(filename, outputFormat) {
	var cSource = fs.readFileSync(filename, "utf8");
	var cTree = parser.parse(cSource);
	var module = new abstractor.Module(cTree);
	if (outputFormat == 'asmjs') {
		var jsTree = asmJsExporter.compileModule(module);
		return escodegen.generate(jsTree, {'verbatim': 'x-verbatim-property'});
	} else if (outputFormat == 'wast') {
		var wasmModule = WasmModule.fromAbstractModule(module);
		return wasmModule.asText();
	} else {
		throw util.format("Unrecognised output format: %s", outputFormat);
	}
};

exports.main = function(argv) {
	var outputFormat;
	if (argv[2] == '--asmjs') {
		outputFormat = 'asmjs';
	} else if (argv[2] == '--wast') {
		outputFormat = 'wast';
	} else {
		throw "Output format must be specified (--asmjs)";
	}

	var cSource = fs.readFileSync(argv[3], "utf8");
	var cTree = parser.parse(cSource);
	console.log(util.inspect(cTree, { depth: null }));

	console.log("\n---------\n");

	var module = new abstractor.Module(cTree);
	console.log(util.inspect(module));

	if (outputFormat == 'asmjs') {
		console.log("\n---------\n");
		var jsTree = asmJsExporter.compileModule(module);
		console.log(util.inspect(jsTree, { depth: null }));

		console.log("\n---------\n");

		var out = escodegen.generate(jsTree, {'verbatim': 'x-verbatim-property'});
		console.log(out);
	} else if (outputFormat == 'wast') {
		console.log("\n---------\n");
		var wasmModule = WasmModule.fromAbstractModule(module);
		console.log(wasmModule.asText());
	}
};

if (typeof module !== 'undefined' && require.main === module) {
	exports.main(process.argv);
}
