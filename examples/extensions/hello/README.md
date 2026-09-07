# hello

The example Arigami extension — one of each contribution kind, nothing else.

```
bin/host ext validate examples/extensions/hello
bin/host ext add      examples/extensions/hello
bin/host ext reload
```

Then, from a NEW session (tools and skills are fixed at spawn):

```
mcp__ext-hello__hello_echo({ text: "world" })
register_listener({ type: "hello-tick", count: 3 })
open_tab({ type: "ext", ext: "hello" })
```

What it contains, and why each file is there, is in `docs/USAGE.md` (which the
loader turns into the skill `/arigami-ext:hello`). The contract itself lives in
`sdk/README.md`.
