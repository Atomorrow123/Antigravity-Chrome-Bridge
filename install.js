#!/usr/bin/env node
/**
 * Antigravity Chrome Bridge — Cross-Platform One-Click Installer
 * Supports:
 *   node install.js             # Install plugin + MCP server + Skill into ~/.gemini/config/plugins/antigravity-chrome-bridge
 *   node install.js --uninstall # Uninstall plugin cleanly
 *   node install.js --dry-run   # Preview paths without modifying disk
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DRY_RUN = process.argv.includes('--dry-run');
const UNINSTALL = process.argv.includes('--uninstall');

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function copyToClipboardWindows(text) {
  if (process.platform !== 'win32') return false;
  try {
    const res = spawnSync('clip', [], { input: text, encoding: 'utf8', windowsHide: true });
    return res.status === 0;
  } catch (_e) {
    return false;
  }
}

function main() {
  const homeDir = os.homedir();
  const configRoot = path.join(homeDir, '.gemini', 'config');
  const targetPluginDir = path.join(configRoot, 'plugins', 'antigravity-chrome-bridge');

  if (UNINSTALL) {
    console.log('============================================================');
    console.log('  Antigravity Chrome Bridge - Uninstaller');
    console.log('============================================================');
    if (fs.existsSync(targetPluginDir)) {
      if (!DRY_RUN) {
        fs.rmSync(targetPluginDir, { recursive: true, force: true });
      }
      console.log(`Removed: ${targetPluginDir}`);
    } else {
      console.log(`Nothing to remove at: ${targetPluginDir}`);
    }
    console.log('Restart Antigravity IDE to apply changes.');
    return;
  }

  const pkgSrcDir = path.join(__dirname, 'antigravity-package');
  if (!fs.existsSync(pkgSrcDir)) {
    console.error('[ERROR] Cannot find antigravity-package directory next to install.js');
    process.exit(1);
  }

  const runtimeDir = path.join(targetPluginDir, 'runtime');
  const mcpStdioScript = path.join(runtimeDir, 'server', 'mcp-stdio.js');
  const permanentExtDir = path.join(runtimeDir, 'extension');

  console.log('============================================================');
  console.log('  Antigravity Chrome Bridge - Installer');
  console.log('============================================================');
  console.log(`Target Plugin Dir : ${targetPluginDir}`);
  console.log(`MCP Server Script : ${mcpStdioScript}`);
  console.log(`Chrome Extension  : ${permanentExtDir}`);
  if (DRY_RUN) {
    console.log('\n[DRY RUN] Validation passed. No files were modified.');
    return;
  }

  console.log('\n[1/3] Installing Antigravity plugin & runtime...');
  copyDirRecursive(pkgSrcDir, targetPluginDir);

  console.log('[2/3] Generating MCP configuration & Skill paths...');
  const mcpConfig = {
    mcpServers: {
      'antigravity-chrome-bridge': {
        command: 'node',
        args: [mcpStdioScript]
      }
    }
  };
  fs.writeFileSync(
    path.join(targetPluginDir, 'mcp_config.json'),
    JSON.stringify(mcpConfig, null, 2) + '\n',
    'utf8'
  );
  const tplPath = path.join(targetPluginDir, 'mcp_config.json.template');
  if (fs.existsSync(tplPath)) {
    fs.unlinkSync(tplPath);
  }

  const skillFile = path.join(targetPluginDir, 'skills', 'chrome-bridge', 'SKILL.md');
  if (fs.existsSync(skillFile)) {
    const rawSkill = fs.readFileSync(skillFile, 'utf8');
    const renderedSkill = rawSkill.split('{{BRIDGE_RUNTIME_DIR}}').join(runtimeDir);
    fs.writeFileSync(skillFile, renderedSkill, 'utf8');
  }

  console.log('[3/3] Checking for duplicate standalone registrations...');
  const globalMcpPath = path.join(configRoot, 'mcp_config.json');
  if (fs.existsSync(globalMcpPath)) {
    try {
      const globalMcp = JSON.parse(fs.readFileSync(globalMcpPath, 'utf8'));
      if (globalMcp?.mcpServers?.['antigravity-chrome-bridge']) {
        delete globalMcp.mcpServers['antigravity-chrome-bridge'];
        fs.writeFileSync(globalMcpPath, JSON.stringify(globalMcp, null, 2) + '\n', 'utf8');
        console.log('      Migrated existing global mcp_config.json entry into plugin bundle.');
      }
    } catch (_err) {}
  }

  const standaloneSkillDir = path.join(configRoot, 'skills', 'chrome-bridge');
  if (fs.existsSync(standaloneSkillDir)) {
    try {
      fs.rmSync(standaloneSkillDir, { recursive: true, force: true });
      console.log('      Consolidated standalone skills/chrome-bridge into plugin bundle.');
    } catch (_err) {}
  }

  const copied = copyToClipboardWindows(permanentExtDir);

  console.log('\n============================================================');
  console.log('  SUCCESS! Antigravity Chrome Bridge installed!');
  console.log('============================================================');
  console.log('\nNext Steps:');
  console.log('  1. Load the Chrome Extension in your browser:');
  console.log('     - Open Chrome and go to: chrome://extensions');
  console.log('     - Turn ON "Developer mode" (top-right toggle)');
  console.log('     - Click "Load unpacked" (加载已解压的扩展程序) and select:');
  console.log(`       ${permanentExtDir}`);
  if (copied) {
    console.log('       (This path has been automatically copied to your clipboard!)');
  }
  console.log('     - Or run launch-chrome-bridge.bat to launch a dedicated Chrome instance automatically.');
  console.log('\n  2. Restart Antigravity IDE so it loads the new plugin & MCP tools.');
}

main();
