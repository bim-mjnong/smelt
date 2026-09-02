# Third-party notices

<!-- GENERATED FILE — do not edit by hand.
     Produced by scripts/generate-third-party.mjs from installed package metadata,
     the bundled grammar files, and packages/core/grammar-provenance.json.
     Regenerate with `pnpm generate:third-party`; a stale copy fails
     packages/core/test/guards/third-party.test.ts. -->

`@smeltjs/core` redistributes the files listed below inside its npm tarball. Everything here is someone else's work, under someone else's licence.

Attribution is required rather than courteous, because the parsers are **shipped**, not merely depended on: that is what makes "no native compilation, works offline" true. If you redistribute smelt, this file travels with it.

## Runtime dependencies

### web-tree-sitter 0.25.10 — MIT

- Repository: https://github.com/tree-sitter/tree-sitter
- Declared range: `~0.25.10`

```text
The MIT License (MIT)

Copyright (c) 2018-2024 Max Brunsfeld

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Bundled tree-sitter grammars

The `.wasm` parsers in `grammars/` were taken from **tree-sitter-wasms 0.1.13** (Unlicense), which prebuilds them. The packaging licence covers the packaging; each grammar carries its own, listed after the table.

| file | from | version range | licence | bytes | sha256 |
| ---- | ---- | ------------- | ------- | ----- | ------ |
| `tree-sitter-bash.wasm` | tree-sitter-bash | `^0.20.5` | MIT | 1400214 | `807dcdb1380a59be` |
| `tree-sitter-c.wasm` | tree-sitter-c | `^0.20.7` | MIT | 792959 | `056b25072382f72d` |
| `tree-sitter-c_sharp.wasm` | tree-sitter-c-sharp | `^0.20.0` | MIT | 3978594 | `6266a7e32d68a345` |
| `tree-sitter-cpp.wasm` | tree-sitter-cpp | `^0.20.4` | MIT | 4662978 | `f6afdf53bfd6de76` |
| `tree-sitter-go.wasm` | tree-sitter-go | `^0.20.0` | MIT | 235957 | `9963ca89b616eaf0` |
| `tree-sitter-java.wasm` | tree-sitter-java | `^0.20.2` | MIT | 430239 | `637aac4415fb39a2` |
| `tree-sitter-javascript.wasm` | tree-sitter-javascript | `^0.20.3` | MIT | 647334 | `63812b9e275d2685` |
| `tree-sitter-kotlin.wasm` | tree-sitter-kotlin | `^0.3.1` | MIT | 4052705 | `b5cb00c8d06ed0f1` |
| `tree-sitter-php.wasm` | tree-sitter-php | `^0.22.0` | MIT | 812594 | `55bb617b6f01e14b` |
| `tree-sitter-python.wasm` | tree-sitter-python | `^0.21.0` | MIT | 476105 | `9056d0fb0c337810` |
| `tree-sitter-ruby.wasm` | tree-sitter-ruby | `^0.20.1` | MIT | 2106447 | `93a5022855314cdb` |
| `tree-sitter-rust.wasm` | tree-sitter-rust | `^0.20.4` | MIT | 818756 | `4409921a70d0aa5b` |
| `tree-sitter-swift.wasm` | tree-sitter-swift | `^0.4.0` | MIT | 3147876 | `41c4fdb2249a3aa6` |
| `tree-sitter-tsx.wasm` | tree-sitter-typescript | `^0.20.5` | MIT | 2411272 | `6aa3b2c70e76f5d4` |
| `tree-sitter-typescript.wasm` | tree-sitter-typescript | `^0.20.5` | MIT | 2342690 | `8515404dceed38e1` |

### Copyright notices

Licence identifiers and copyright lines below were verified on **2026-09-02** against the npm registry and each repository's `LICENSE` file, and are recorded in `grammar-provenance.json`. They are not derivable on this machine: a `.wasm` blob carries no metadata, and the grammar packages are tree-sitter-wasms's own devDependencies, so they are never installed here.

- **tree-sitter-bash** — MIT — Copyright (c) 2017 Max Brunsfeld — https://github.com/tree-sitter/tree-sitter-bash
- **tree-sitter-c** — MIT — Copyright (c) 2014 Max Brunsfeld — https://github.com/tree-sitter/tree-sitter-c
- **tree-sitter-c-sharp** — MIT — Copyright (c) 2014-2023 Max Brunsfeld, Damien Guard, Amaan Qureshi, and contributors. — https://github.com/tree-sitter/tree-sitter-c-sharp
- **tree-sitter-cpp** — MIT — Copyright (c) 2014 Max Brunsfeld — https://github.com/tree-sitter/tree-sitter-cpp
- **tree-sitter-go** — MIT — Copyright (c) 2014 Max Brunsfeld — https://github.com/tree-sitter/tree-sitter-go
- **tree-sitter-java** — MIT — Copyright (c) 2017 Ayman Nadeem — https://github.com/tree-sitter/tree-sitter-java
- **tree-sitter-javascript** — MIT — Copyright (c) 2014 Max Brunsfeld — https://github.com/tree-sitter/tree-sitter-javascript
- **tree-sitter-kotlin** — MIT — Copyright (c) 2019 fwcd — https://github.com/fwcd/tree-sitter-kotlin
- **tree-sitter-php** — MIT — Copyright (c) 2017 Josh Vera, GitHub — https://github.com/tree-sitter/tree-sitter-php
- **tree-sitter-python** — MIT — Copyright (c) 2016 Max Brunsfeld — https://github.com/tree-sitter/tree-sitter-python
- **tree-sitter-ruby** — MIT — Copyright (c) 2016 Rob Rix — https://github.com/tree-sitter/tree-sitter-ruby
- **tree-sitter-rust** — MIT — Copyright (c) 2017 Maxim Sokolov — https://github.com/tree-sitter/tree-sitter-rust
- **tree-sitter-swift** — MIT — Copyright (c) 2021 alex-pinkus — https://github.com/alex-pinkus/tree-sitter-swift
- **tree-sitter-typescript** — MIT — Copyright (c) 2017 Max Brunsfeld — https://github.com/tree-sitter/tree-sitter-typescript

### Packaging licence

```text
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org>
```

### The MIT licence

Every grammar above is MIT. The body is reproduced once, quoted from the installed `web-tree-sitter` `LICENSE` — each grammar's own copy differs only in the copyright line listed above.

```text
The MIT License (MIT)

Copyright (c) 2018-2024 Max Brunsfeld

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
