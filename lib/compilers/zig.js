// Copyright (c) 2018, Marc Tiehuis
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import path from 'path';

import Semver from 'semver';
import _ from 'underscore';

import {BaseCompiler} from '../base-compiler';
import {asSafeVer} from '../utils';

export class ZigCompiler extends BaseCompiler {
    static get key() {
        return 'zig';
    }

    constructor(info, env) {
        super(info, env);
        this.compiler.supportsIntel = true;
        this.compiler.supportsIrView = true;

        this.self_hosted_cli =
            this.compiler.semver === 'trunk' ||
            (this.compiler.semver && Semver.gt(asSafeVer(this.compiler.semver), '0.6.0', true));

        if (this.self_hosted_cli) {
            this.compiler.irArg = ['-femit-llvm-ir'];
        } else {
            this.compiler.irArg = ['--emit', 'llvm-ir'];
        }
    }

    getSharedLibraryPathsAsArguments() {
        return [];
    }

    preProcess(source) {
        if (Semver.eq(asSafeVer(this.compiler.semver), '0.2.0', true)) {
            source += '\n';
            source += 'extern fn zig_panic() noreturn;\n';
            source += 'pub fn panic(msg: []const u8, error_return_trace: ?&@import("builtin").StackTrace) noreturn {\n';
            source += '    zig_panic();\n';
            source += '}\n';
        } else if (
            Semver.gte(asSafeVer(this.compiler.semver), '0.3.0', true) &&
            Semver.lte(asSafeVer(this.compiler.semver), '0.7.1', true)
        ) {
            source += '\n';
            source += 'extern fn zig_panic() noreturn;\n';
            source += 'pub fn panic(msg: []const u8, error_return_trace: ?*@import("builtin").StackTrace) noreturn {\n';
            source += '    zig_panic();\n';
            source += '}\n';
        } else {
            source += '\n';
            source += 'extern fn zig_panic() noreturn;\n';
            source +=
                'pub fn panic(msg: []const u8, error_return_trace: ' +
                '?*@import("std").builtin.StackTrace) noreturn {\n';
            source += '    _ = msg;\n';
            source += '    _ = error_return_trace;\n';
            source += '    zig_panic();\n';
            source += '}\n';
        }

        return source;
    }

    optionsForFilter(filters, outputFilename, userOptions) {
        let options = [filters.execute ? 'build-exe' : 'build-obj'];

        const desiredName = path.basename(outputFilename);
        // strip '.s' if we aren't executing
        const name = filters.execute ? desiredName : desiredName.slice(0, -2);

        if (this.self_hosted_cli) {
            // Versions after 0.6.0 use a different command line interface.
            const outputDir = path.dirname(outputFilename);
            options.push('--cache-dir', outputDir, '--name', name);

            if (!filters.binary) {
                options.push('-fno-emit-bin', '-femit-asm=' + desiredName);
            } else {
                options.push('-femit-bin=' + desiredName);
            }
            return options;
        }

        if (this.compiler.semver && Semver.gt(asSafeVer(this.compiler.semver), '0.3.0', true)) {
            const outputDir = path.dirname(outputFilename);
            options.push('--cache-dir', outputDir, '--output-dir', outputDir, '--name', name);
        } else {
            // Older versions use a different command line interface (#1304)
            options.push(
                '--cache-dir',
                path.dirname(outputFilename),
                '--output',
                this.filename(outputFilename),
                '--output-h',
                '/dev/null',
            );
        }

        if (!filters.binary) {
            let userRequestedEmit = _.any(userOptions, opt => opt.includes('--emit'));
            if (!userRequestedEmit) {
                options = options.concat('--emit', 'asm');
            }
            if (filters.intel) options = options.concat('-mllvm', '--x86-asm-syntax=intel');
        }
        return options;
    }

    getIncludeArguments(libraries) {
        return _.flatten(
            _.map(libraries, selectedLib => {
                const foundVersion = this.findLibVersion(selectedLib);
                if (!foundVersion) return false;
                // Zig should not have more than 1 path
                return ['--pkg-begin', foundVersion.name, foundVersion.path, '--pkg-end'];
            }),
        );
    }

    getIrOutputFilename(inputFilename) {
        return this.getOutputFilename(path.dirname(inputFilename), this.outputFilebase).replace('.s', '.ll');
    }

    filterUserOptions(userOptions) {
        const forbiddenOptions = /^(((--(cache-dir|name|output|verbose))|(-(mllvm|f(no-)?emit-))).*)$/;
        return _.filter(userOptions, option => !forbiddenOptions.test(option));
    }

    isCfgCompiler(/*compilerVersion*/) {
        return true;
    }
}
