import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'fs';

const isWatch = process.argv.includes('--watch');

// Ensure dist directory exists
if (!existsSync('dist')) {
  mkdirSync('dist', { recursive: true });
}

// Build background script
const backgroundBuildOptions = {
  entryPoints: ['src/background.ts'],
  bundle: true,
  outfile: 'dist/background.js',
  format: 'esm',
  target: 'esnext',
  platform: 'browser',
  sourcemap: true,
  minify: false,
};

// Build content script (IIFE format for content scripts)
const contentBuildOptions = {
  entryPoints: ['src/content.ts'],
  bundle: true,
  outfile: 'dist/content.js',
  format: 'iife',
  target: 'esnext',
  platform: 'browser',
  sourcemap: true,
  minify: false,
};

// Copy static files
function copyStatic() {
  const staticFiles = [
    'manifest.json',
    'dashboard.html',
    'dashboard.js',
    'popup.html',
    'popup.js',
    'options.html',
    'options.js',
  ];
  for (const file of staticFiles) {
    copyFileSync(`src/${file}`, `dist/${file}`);
    console.log(`✓ Copied ${file}`);
  }

  // Copy icons from assets to dist
  if (!existsSync('dist/icons')) {
    mkdirSync('dist/icons', { recursive: true });
  }
  const icons = readdirSync('assets/icons');
  for (const icon of icons) {
    copyFileSync(`assets/icons/${icon}`, `dist/icons/${icon}`);
  }
  console.log(`✓ Copied ${icons.length} icons`);
}

async function build() {
  try {
    if (isWatch) {
      const bgCtx = await esbuild.context(backgroundBuildOptions);
      const contentCtx = await esbuild.context(contentBuildOptions);
      await Promise.all([bgCtx.watch(), contentCtx.watch()]);
      console.log('👀 Watching for changes...');
      copyStatic();
    } else {
      await Promise.all([
        esbuild.build(backgroundBuildOptions),
        esbuild.build(contentBuildOptions),
      ]);
      console.log('✓ Built background.js');
      console.log('✓ Built content.js');
      copyStatic();
      console.log('✓ Build complete! Load dist/ as unpacked extension.');
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
