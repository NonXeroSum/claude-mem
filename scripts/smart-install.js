#!/usr/bin/env node
/**
 * Smart Install Script for claude-mem
 *
 * Ensures Bun runtime and uv (Python package manager) are installed
 * (auto-installs if missing) and handles dependency installation when needed.
 *
 * Resolves the install directory from CLAUDE_PLUGIN_ROOT (set by Claude Code
 * for both cache and marketplace installs), falling back to script location
 * and legacy paths.
 *
 * VENDORED: External installers are vendored locally with checksum verification
 * to mitigate supply-chain risk (SC2). See vendored/CHECKSUMS for details.
 */
import { existsSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

// Early exit if plugin is disabled in Claude Code settings (#781)
function isPluginDisabledInClaudeSettings() {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(configDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return settings?.enabledPlugins?.['claude-mem@thedotmack'] === false;
  } catch {
    return false;
  }
}

if (isPluginDisabledInClaudeSettings()) {
  process.exit(0);
}
const IS_WINDOWS = process.platform === 'win32';

/**
 * Compute SHA256 checksum of a file
 */
function computeChecksum(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Verify that a vendored file matches its expected checksum
 * Throws if checksum mismatch detected
 */
function verifyChecksum(filePath, expectedHash) {
  const actual = computeChecksum(filePath);
  if (actual !== expectedHash) {
    throw new Error(
      `Checksum mismatch for ${filePath}\n` +
      `  Expected: ${expectedHash}\n` +
      `  Actual:   ${actual}\n` +
      `This may indicate file corruption or tampering. Installation aborted.`
    );
  }
}

/**
 * Load and verify a vendored installer script
 * Returns the script content if checksum is valid
 */
function loadVendoredInstaller(scriptName, expectedHash) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const vendoredPath = join(scriptDir, '..', 'vendored', scriptName);

  if (!existsSync(vendoredPath)) {
    throw new Error(
      `Vendored installer not found: ${scriptName}\n` +
      `Expected at: ${vendoredPath}\n` +
      `This may indicate an incomplete plugin installation.`
    );
  }

  verifyChecksum(vendoredPath, expectedHash);
  return readFileSync(vendoredPath, 'utf-8');
}

/**
 * Resolve the plugin root directory where dependencies should be installed.
 *
 * Priority:
 * 1. CLAUDE_PLUGIN_ROOT env var (set by Claude Code for hooks — works for
 *    both cache-based and marketplace installs)
 * 2. Script location (dirname of this file, up one level from scripts/)
 * 3. XDG path (~/.config/claude/plugins/marketplaces/thedotmack)
 * 4. Legacy path (~/.claude/plugins/marketplaces/thedotmack)
 */
function resolveRoot() {
  // CLAUDE_PLUGIN_ROOT is the authoritative location set by Claude Code
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (existsSync(join(root, 'package.json'))) return root;
  }

  // Derive from script location (this file is in <root>/scripts/)
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const candidate = dirname(scriptDir);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  } catch {
    // import.meta.url not available
  }

  // Probe XDG path, then legacy
  const marketplaceRel = join('plugins', 'marketplaces', 'thedotmack');
  const xdg = join(homedir(), '.config', 'claude', marketplaceRel);
  if (existsSync(join(xdg, 'package.json'))) return xdg;

  return join(homedir(), '.claude', marketplaceRel);
}

const ROOT = resolveRoot();
const MARKER = join(ROOT, '.install-version');

/**
 * Check if Bun is installed and accessible
 */
function isBunInstalled() {
  try {
    const result = spawnSync('bun', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    if (result.status === 0) return true;
  } catch {
    // PATH check failed, try common installation paths
  }

  // Check common installation paths (handles fresh installs before PATH reload)
  const bunPaths = IS_WINDOWS
    ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

  return bunPaths.some(existsSync);
}

/**
 * Get the Bun executable path (from PATH or common install locations)
 */
function getBunPath() {
  // Try PATH first
  try {
    const result = spawnSync('bun', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    if (result.status === 0) return 'bun';
  } catch {
    // Not in PATH
  }

  // Check common installation paths
  const bunPaths = IS_WINDOWS
    ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

  for (const bunPath of bunPaths) {
    if (existsSync(bunPath)) return bunPath;
  }

  return null;
}

/**
 * Minimum required bun version
 * v1.1.14+ required for .changes property and multi-statement SQL support
 */
const MIN_BUN_VERSION = '1.1.14';

/**
 * Compare semver versions
 */
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * Check if bun version meets minimum requirements
 */
function isBunVersionSufficient() {
  const version = getBunVersion();
  if (!version) return false;
  return compareVersions(version, MIN_BUN_VERSION) >= 0;
}

/**
 * Get Bun version if installed
 */
function getBunVersion() {
  const bunPath = getBunPath();
  if (!bunPath) return null;

  try {
    const result = spawnSync(bunPath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Check if uv is installed and accessible
 */
function isUvInstalled() {
  try {
    const result = spawnSync('uv', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    if (result.status === 0) return true;
  } catch {
    // PATH check failed, try common installation paths
  }

  // Check common installation paths (handles fresh installs before PATH reload)
  const uvPaths = IS_WINDOWS
    ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe')]
    : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv', '/opt/homebrew/bin/uv'];

  return uvPaths.some(existsSync);
}

/**
 * Get uv version if installed
 */
function getUvVersion() {
  try {
    const result = spawnSync('uv', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Install Bun automatically based on platform
 * Uses vendored installer with checksum verification
 */
function installBun() {
  console.error('🔧 Bun not found. Installing Bun runtime...');

  // SHA256 checksums of vendored installers (computed 2026-06-14)
  const BUN_INSTALL_SH_HASH = 'bab8acfb046aac8c72407bdcce903957665d655d7acaa3e11c7c4616beae68dd';
  const BUN_INSTALL_PS1_HASH = '54fd5c34e08d2e363e9ee4cc52f58eca72b3c307c170869eec1e394c16fb7744';

  try {
    if (IS_WINDOWS) {
      // Windows: Use vendored PowerShell installer
      console.error('   Installing via vendored PowerShell script...');
      const script = loadVendoredInstaller('bun-install.ps1', BUN_INSTALL_PS1_HASH);
      execSync(`powershell -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, {
        stdio: ['pipe', 'pipe', 'inherit'],
        shell: true
      });
    } else {
      // Unix/macOS: Use vendored bash installer
      console.error('   Installing via vendored bash script...');
      const script = loadVendoredInstaller('bun-install.sh', BUN_INSTALL_SH_HASH);
      execSync(`bash -s <<'SCRIPT_EOF'\n${script}\nSCRIPT_EOF`, {
        stdio: ['pipe', 'pipe', 'inherit'],
        shell: true
      });
    }

    // Verify installation
    if (isBunInstalled()) {
      const version = getBunVersion();
      console.error(`✅ Bun ${version} installed successfully`);
      return true;
    } else {
      // Bun may be installed but not in PATH yet for this session
      // Try common installation paths
      const bunPaths = IS_WINDOWS
        ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
        : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

      for (const bunPath of bunPaths) {
        if (existsSync(bunPath)) {
          console.error(`✅ Bun installed at ${bunPath}`);
          console.error('⚠️  Please restart your terminal or add Bun to PATH:');
          if (IS_WINDOWS) {
            console.error(`   $env:Path += ";${join(homedir(), '.bun', 'bin')}"`);
          } else {
            console.error(`   export PATH="$HOME/.bun/bin:$PATH"`);
          }
          return true;
        }
      }

      throw new Error('Bun installation completed but binary not found');
    }
  } catch (error) {
    console.error('❌ Failed to install Bun automatically');
    console.error('   Please install manually:');
    if (IS_WINDOWS) {
      console.error('   - winget install Oven-sh.Bun');
      console.error('   - Or: https://bun.sh');
    } else {
      console.error('   - brew install oven-sh/bun/bun');
      console.error('   - Or: https://bun.sh');
    }
    console.error('   Then restart your terminal and try again.');
    throw error;
  }
}

/**
 * Install uv automatically based on platform
 * Uses vendored installer with checksum verification
 */
function installUv() {
  console.error('🐍 Installing uv for Python/Chroma support...');

  // SHA256 checksums of vendored installers (computed 2026-06-14)
  const UV_INSTALL_SH_HASH = '053045e1e69ec77358fd44f2ef2cacb768a22d50f433e213624f0157ffbbc883';
  const UV_INSTALL_PS1_HASH = '0ce635ed6670498d72930763357d9e44251887130d2eafd6aa9ba4f8299ec216';

  try {
    if (IS_WINDOWS) {
      // Windows: Use vendored PowerShell installer
      console.error('   Installing via vendored PowerShell script...');
      const script = loadVendoredInstaller('uv-install.ps1', UV_INSTALL_PS1_HASH);
      execSync(`powershell -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, {
        stdio: ['pipe', 'pipe', 'inherit'],
        shell: true
      });
    } else {
      // Unix/macOS: Use vendored bash installer
      console.error('   Installing via vendored bash script...');
      const script = loadVendoredInstaller('uv-install.sh', UV_INSTALL_SH_HASH);
      execSync(`bash -s <<'SCRIPT_EOF'\n${script}\nSCRIPT_EOF`, {
        stdio: ['pipe', 'pipe', 'inherit'],
        shell: true
      });
    }

    // Verify installation
    if (isUvInstalled()) {
      const version = getUvVersion();
      console.error(`✅ uv ${version} installed successfully`);
      return true;
    } else {
      // uv may be installed but not in PATH yet for this session
      // Try common installation paths
      const uvPaths = IS_WINDOWS
        ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe')]
        : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv', '/opt/homebrew/bin/uv'];

      for (const uvPath of uvPaths) {
        if (existsSync(uvPath)) {
          console.error(`✅ uv installed at ${uvPath}`);
          console.error('⚠️  Please restart your terminal or add uv to PATH:');
          if (IS_WINDOWS) {
            console.error(`   $env:Path += ";${join(homedir(), '.local', 'bin')}"`);
          } else {
            console.error(`   export PATH="$HOME/.local/bin:$PATH"`);
          }
          return true;
        }
      }

      throw new Error('uv installation completed but binary not found');
    }
  } catch (error) {
    console.error('❌ Failed to install uv automatically');
    console.error('   Please install manually:');
    if (IS_WINDOWS) {
      console.error('   - winget install astral-sh.uv');
      console.error('   - Or: https://docs.astral.sh/uv/guides/integration/');
    } else {
      console.error('   - brew install uv (macOS)');
      console.error('   - Or: https://docs.astral.sh/uv/guides/integration/');
    }
    console.error('   Then restart your terminal and try again.');
    throw error;
  }
}

/**
 * Add shell alias for claude-mem command
 */
function installCLI() {
  const WORKER_CLI = join(ROOT, 'scripts', 'worker-service.cjs');
  const bunPath = getBunPath() || 'bun';
  const aliasLine = `alias claude-mem='${bunPath} "${WORKER_CLI}"'`;
  const markerPath = join(ROOT, '.cli-installed');

  // Skip if already installed
  if (existsSync(markerPath)) return;

  try {
    if (IS_WINDOWS) {
      // Windows: Add to PATH via PowerShell profile
      const profilePath = join(process.env.USERPROFILE || homedir(), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
      const profileDir = join(process.env.USERPROFILE || homedir(), 'Documents', 'PowerShell');
      const functionDef = `function claude-mem { & "${bunPath}" "${WORKER_CLI}" $args }\n`;

      if (!existsSync(profileDir)) {
        execSync(`mkdir "${profileDir}"`, { stdio: 'ignore', shell: true });
      }

      const existingContent = existsSync(profilePath) ? readFileSync(profilePath, 'utf-8') : '';
      if (!existingContent.includes('function claude-mem')) {
        writeFileSync(profilePath, existingContent + '\n' + functionDef);
        console.error(`✅ PowerShell function added to profile`);
        console.error('   Restart your terminal to use: claude-mem <command>');
      }
    } else {
      // Unix: Add alias to shell configs
      const shellConfigs = [
        join(homedir(), '.bashrc'),
        join(homedir(), '.zshrc')
      ];

      for (const config of shellConfigs) {
        if (existsSync(config)) {
          const content = readFileSync(config, 'utf-8');
          if (!content.includes('alias claude-mem=')) {
            writeFileSync(config, content + '\n' + aliasLine + '\n');
            console.error(`✅ Alias added to ${config}`);
          }
        }
      }
      console.error('   Restart your terminal to use: claude-mem <command>');
    }

    writeFileSync(markerPath, new Date().toISOString());
  } catch (error) {
    console.error(`⚠️  Could not add shell alias: ${error.message}`);
    console.error(`   Use directly: ${bunPath} "${WORKER_CLI}" <command>`);
  }
}

/**
 * Check if dependencies need to be installed
 */
function needsInstall() {
  if (!existsSync(join(ROOT, 'node_modules'))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const marker = JSON.parse(readFileSync(MARKER, 'utf-8'));
    return pkg.version !== marker.version || getBunVersion() !== marker.bun;
  } catch {
    return true;
  }
}

/**
 * Install dependencies using Bun with npm fallback
 *
 * Bun has issues with npm alias packages (e.g., string-width-cjs, strip-ansi-cjs)
 * that are defined in package-lock.json. When bun fails with 404 errors for these
 * packages, we fall back to npm which handles aliases correctly.
 */
function installDeps() {
  const bunPath = getBunPath();
  if (!bunPath) {
    throw new Error('Bun executable not found');
  }

  console.error('📦 Installing dependencies with Bun...');

  // Quote path for Windows paths with spaces
  const bunCmd = IS_WINDOWS && bunPath.includes(' ') ? `"${bunPath}"` : bunPath;

  // Use pipe for stdout to prevent non-JSON output leaking to Claude Code hooks.
  // stderr is inherited so progress/errors are still visible to the user.
  const installStdio = ['pipe', 'pipe', 'inherit'];

  let bunSucceeded = false;
  try {
    execSync(`${bunCmd} install`, { cwd: ROOT, stdio: installStdio, shell: IS_WINDOWS });
    bunSucceeded = true;
  } catch {
    // First attempt failed, try with force flag
    try {
      execSync(`${bunCmd} install --force`, { cwd: ROOT, stdio: installStdio, shell: IS_WINDOWS });
      bunSucceeded = true;
    } catch {
      // Bun failed completely, will try npm fallback
    }
  }

  // Fallback to npm if bun failed (handles npm alias packages correctly)
  if (!bunSucceeded) {
    console.error('⚠️  Bun install failed, falling back to npm...');
    console.error('   (This can happen with npm alias packages like *-cjs)');
    try {
      execSync('npm install --legacy-peer-deps', { cwd: ROOT, stdio: installStdio, shell: IS_WINDOWS });
    } catch (npmError) {
      throw new Error('Both bun and npm install failed: ' + npmError.message);
    }
  }

  // Write version marker
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  writeFileSync(MARKER, JSON.stringify({
    version: pkg.version,
    bun: getBunVersion(),
    uv: getUvVersion(),
    installedAt: new Date().toISOString()
  }));
}

/**
 * Verify that critical runtime modules are resolvable from the install directory.
 * Returns true if all critical modules exist, false otherwise.
 */
function verifyCriticalModules() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const dependencies = Object.keys(pkg.dependencies || {});

  const missing = [];
  for (const dep of dependencies) {
    // Check that the module directory exists in node_modules
    const modulePath = join(ROOT, 'node_modules', ...dep.split('/'));
    if (!existsSync(modulePath)) {
      missing.push(dep);
    }
  }

  if (missing.length > 0) {
    console.error(`❌ Post-install check failed: missing modules: ${missing.join(', ')}`);
    return false;
  }

  return true;
}

// Mach-O 64-bit magic values as seen when reading the first 4 file bytes with readUInt32LE.
// Native arm64/x86_64 Mach-O files start with bytes [CF FA ED FE]; readUInt32LE gives 0xFEEDFACF.
// Byte-swapped (big-endian) Mach-O files start with bytes [FE ED FA CF]; readUInt32LE gives 0xCFFAEDFE.
const MACHO_MAGIC_NATIVE  = 0xFEEDFACF; // native 64-bit (arm64/x86_64) — file bytes CF FA ED FE
const MACHO_MAGIC_SWAPPED = 0xCFFAEDFE; // byte-swapped 64-bit             — file bytes FE ED FA CF

/**
 * Warn when the bundled claude-mem binary cannot run on the current platform.
 *
 * The committed binary (plugin/scripts/claude-mem) is compiled for macOS arm64.
 * On Linux or Windows it produces "Exec format error" and silently fails.
 * This check surfaces the incompatibility at install time so users know why
 * the binary path doesn't work, and confirms the JS fallback (bun-runner.js →
 * worker-service.cjs) is active and covers all functionality.
 *
 * Fixes #1547 — Plugin silently fails on Linux ARM64.
 */
export function checkBinaryPlatformCompatibility(binaryPath = join(ROOT, 'scripts', 'claude-mem')) {

  if (!existsSync(binaryPath)) {
    return; // Binary absent — nothing to check (e.g. after npm install which excludes it)
  }

  // The binary only matters on non-macOS platforms; on macOS it works correctly.
  if (process.platform === 'darwin') {
    return;
  }

  // Read the first 4 bytes to identify the binary format.
  let fd;
  try {
    const buf = Buffer.alloc(4);
    fd = openSync(binaryPath, 'r');
    readSync(fd, buf, 0, 4, 0);

    const magic = buf.readUInt32LE(0);
    if (magic === MACHO_MAGIC_NATIVE || magic === MACHO_MAGIC_SWAPPED) {
      console.error('⚠️  Platform notice: The bundled claude-mem binary is macOS-only.');
      console.error(`   Current platform: ${process.platform} ${process.arch}`);
      console.error('   The binary will not execute on this platform.');
      console.error('   Plugin functionality is provided by the JS fallback');
      console.error('   (bun-runner.js → worker-service.cjs) which works on all platforms.');
    }
  } catch {
    // Unreadable binary — not critical, skip silently
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Main execution
try {
  // Step 1: Ensure Bun is installed and meets minimum version (REQUIRED)
  if (!isBunInstalled()) {
    installBun();

    // Re-check after installation
    if (!isBunInstalled()) {
      console.error('❌ Bun is required but not available in PATH');
      console.error('   Please restart your terminal after installation');
      process.exit(1);
    }
  }

  // Step 1.5: Ensure Bun version is sufficient
  if (!isBunVersionSufficient()) {
    const currentVersion = getBunVersion();
    console.error(`⚠️  Bun ${currentVersion} is outdated. Minimum required: ${MIN_BUN_VERSION}`);
    console.error('   Upgrading bun...');
    try {
      execSync('bun upgrade', { stdio: ['pipe', 'pipe', 'inherit'], shell: IS_WINDOWS });
      if (!isBunVersionSufficient()) {
        console.error(`❌ Bun upgrade failed. Please manually upgrade: bun upgrade`);
        process.exit(1);
      }
      console.error(`✅ Bun upgraded to ${getBunVersion()}`);
    } catch (error) {
      console.error(`❌ Failed to upgrade bun: ${error.message}`);
      console.error('   Please manually upgrade: bun upgrade');
      process.exit(1);
    }
  }

  // Step 2: Ensure uv is installed (REQUIRED for vector search)
  if (!isUvInstalled()) {
    installUv();

    // Re-check after installation
    if (!isUvInstalled()) {
      console.error('❌ uv is required but not available in PATH');
      console.error('   Please restart your terminal after installation');
      process.exit(1);
    }
  }

  // Step 3: Install dependencies if needed
  if (needsInstall()) {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const newVersion = pkg.version;

    installDeps();

    // Verify critical modules are resolvable
    if (!verifyCriticalModules()) {
      console.error('⚠️  Retrying install with npm...');
      try {
        execSync('npm install --production --legacy-peer-deps', { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'], shell: IS_WINDOWS });
      } catch {
        // npm also failed
      }
      if (!verifyCriticalModules()) {
        console.error('❌ Dependencies could not be installed. Plugin may not work correctly.');
        process.exit(1);
      }
    }

    console.error('✅ Dependencies installed');

    // Auto-restart worker to pick up new code
    const port = process.env.CLAUDE_MEM_WORKER_PORT || 37777;
    console.error(`[claude-mem] Plugin updated to v${newVersion} - restarting worker...`);
    try {
      // Graceful shutdown via HTTP (curl is cross-platform enough)
      execSync(`curl -s -X POST http://127.0.0.1:${port}/api/admin/shutdown`, {
        stdio: 'ignore',
        shell: IS_WINDOWS,
        timeout: 5000
      });
      // Brief wait for port to free
      execSync(IS_WINDOWS ? 'timeout /t 1 /nobreak >nul' : 'sleep 0.5', {
        stdio: 'ignore',
        shell: true
      });
    } catch {
      // Worker wasn't running or already stopped - that's fine
    }
    // Worker will be started fresh by next hook in chain (worker-service.cjs start)
  }

  // Step 4: Install CLI to PATH
  installCLI();

  // Step 5: Warn if the bundled native binary is incompatible with this platform
  checkBinaryPlatformCompatibility();

  // Output valid JSON for Claude Code hook contract
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
} catch (e) {
  console.error('❌ Installation failed:', e.message);
  // Still output valid JSON so Claude Code doesn't show a confusing error
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(1);
}
