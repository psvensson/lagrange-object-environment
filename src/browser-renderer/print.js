// The example:example/print import the triangle Component declares (its debug
// output). PR B routes it to the console; it carries no semantics.
// The transpiled Component does `import print from ...` then calls print(...),
// so the DEFAULT export is the function itself.
export default function print(s) {
  console.log('[triangle]', s);
}
