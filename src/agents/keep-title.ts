// Loaded with --import ahead of npm on macOS. npm sets process.title, and on
// macOS libuv hands a process title to LaunchServices; the Node that runs npm
// lives in the app's Contents/MacOS, so macOS takes the titled process for an
// app of its own and shows a blank "exec" icon in the Dock, named after the
// npm command, for as long as an install runs (an owner took it for a stuck
// Node). With the setter a no-op nothing is handed over; npm only reads it back.
Object.defineProperty(process, 'title', { configurable: true, get: () => 'npm', set: () => {} });

export {};
