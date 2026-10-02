Apply context-based patches to files. Prefer this tool for changes with multiple hunks or files.

For a freeform call, send the patch itself, without JSON or Markdown fences. For a JSON function call, pass the same text as `input`.

Use this format:

*** Begin Patch
*** Add File: src/new.ts
+export const answer = 42;
*** Update File: src/existing.ts
@@
 unchanged context
-old line
+new line
*** Delete File: src/obsolete.ts
*** End Patch

- Read the relevant file contents before constructing a patch. Use current, exact context without Read's line-number prefixes. Independent hunks can be applied together without re-reading the file between them.
- Update hunks use a leading space for unchanged context, `-` for removals and `+` for additions. `@@` separates hunks; `@@ exact context line` can locate a section. `*** End of File` anchors the last hunk at the end of the file.
- Add File creates a new file; every content line starts with `+`. It refuses to overwrite an existing path. Delete File removes one existing regular file.
- Use each path only once per patch. Moves, binary files, symlinks, and mixed line endings are unsupported. Use LF in patches; existing pure CRLF files retain their line endings.
- Relative paths resolve against the working directory. Existing path and permission rules apply to every file.
- All files and hunks are checked before writing. A syntax, path or matching error changes no file. Writes across files are not an atomic transaction: if an I/O error occurs, the result lists completed files and the failing file; inspect that result before retrying.
