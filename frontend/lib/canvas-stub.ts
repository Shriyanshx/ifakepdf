// Canvas stub – this file is used by Turbopack to replace the native `canvas`
// module during SSR compilation. PDF.js only needs `canvas` in the browser,
// which is always available. Returning an empty module here prevents build errors.
export default {};
