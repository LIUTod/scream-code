// mupdf instantiates its WASM module with a default stdout/stderr printer.
// Left alone, the first PDF conversion writes engine chatter straight into the
// terminal and corrupts the TUI. The hook must be installed before that import
// runs, which is why this module is imported from the markit barrel.
//
// `??=` keeps a richer logger in place when a caller (the agent runtime) has
// already installed one.

interface MuPdfWasmModuleConfig {
	print?: (...values: unknown[]) => void;
	printErr?: (...values: unknown[]) => void;
}

const globalScope = globalThis as { $libmupdf_wasm_Module?: MuPdfWasmModuleConfig };
const moduleConfig: MuPdfWasmModuleConfig = globalScope.$libmupdf_wasm_Module ?? {};
moduleConfig.print ??= () => {};
moduleConfig.printErr ??= () => {};
globalScope.$libmupdf_wasm_Module = moduleConfig;
