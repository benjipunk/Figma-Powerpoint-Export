const eslint = require('@eslint/js')
const tseslint = require('typescript-eslint')
const figmaPlugin = require('@figma/eslint-plugin-figma-plugins')

module.exports = tseslint.config(
  eslint.configs.recommended,
  // @typescript-eslint/recommended-type-checked is too aggressive for
  // widget code...it doesn't seem to like JSX element return values or
  // unbundling the `widget` object for use* hooks. So we'll use
  // tseslint.configs.recommended instead.
  tseslint.configs.recommended,
  {
    // Node scripts (CommonJS): build tooling.
    files: ['build.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', __dirname: 'readonly', process: 'readonly', console: 'readonly',
        Buffer: 'readonly', setTimeout: 'readonly', fetch: 'readonly', WebSocket: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
  },
  {
    plugins: {
      '@figma/figma-plugins': figmaPlugin,
    },
    rules: {
      ...figmaPlugin.configs.recommended.rules,
      // allow underscore-prefixing of unused variables
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    ignores: ['dist', 'eslint.config.js', 'node_modules'],
  },
)
