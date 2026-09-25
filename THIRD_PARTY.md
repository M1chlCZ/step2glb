# Third-party software

step2glb uses these packages. Each package ships its own license text.

| Package | License |
| --- | --- |
| occt-import-js | LGPL-2.1 |
| three | MIT |
| @gltf-transform/core | MIT |
| @gltf-transform/extensions | MIT |
| @gltf-transform/functions | MIT |
| draco3dgltf | Apache-2.0 |

occt-import-js contains a WebAssembly build of Open CASCADE Technology. It is a
separate npm package. The upstream project is
https://github.com/kovacsv/occt-import-js. Its license text is in the package at
`node_modules/occt-import-js/LICENSE.md`. If you redistribute a copy of the
package, keep the license files and make the source available.

The package `@gltf-transform/functions` installs `sharp`. That package installs
platform binaries from the `@img/sharp-libvips-*` packages. Those packages use
LGPL-3.0-or-later. They are separate npm dependencies. If you redistribute them,
keep their license files.
