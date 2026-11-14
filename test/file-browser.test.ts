import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browseBotFiles } from '../src/file-browser.ts';
import { Runtime } from '../src/runtime.ts';
import { hasUnsavedSettings } from '../desktop/renderer/settings-draft.ts';

test('file browser merges this bot’s originals and folders, searches nested paths and paginates all entries', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'xw-browser-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const runtime=Runtime.open(root);t.after(()=>runtime.close());const bot=runtime.activeBot();
  const own=runtime.store.addLibraryBytes(bot.id,'论文.pdf',Buffer.from('pdf')).ref;
  const other=runtime.store.createBot({name:'Other',systemPrompt:''});runtime.store.addLibraryBytes(other.id,'别的任务.txt',Buffer.from('other'));
  await mkdir(path.join(bot.workspaceDir,'slides'),{recursive:true});await mkdir(path.join(bot.workspaceDir,'notes'),{recursive:true});
  await writeFile(path.join(bot.workspaceDir,'slides','汇报.html'),'deck');await writeFile(path.join(bot.workspaceDir,'notes','结论.md'),'notes');
  await writeFile(path.join(bot.workspaceDir,'raw.bin'),'unknown');
  const refs=runtime.store.listLibrary(bot.id);const all=await browseBotFiles(bot.workspaceDir,refs,{source:'all'});
  assert.ok(all.entries.some(item=>item.refId===own.id));assert.equal(all.entries.some(item=>item.name==='别的任务.txt'),false);
  assert.equal(all.entries.find(item=>item.name==='raw.bin')?.preview,'unsupported');
  const found=await browseBotFiles(bot.workspaceDir,refs,{source:'workspace',query:'汇报',type:'canvas'});
  assert.equal(found.entries[0]?.path,'slides/汇报.html');
  const folder=await browseBotFiles(bot.workspaceDir,refs,{source:'workspace',path:'slides'});assert.equal(folder.entries[0]?.preview,'canvas');
  await assert.rejects(browseBotFiles(bot.workspaceDir,refs,{source:'workspace',path:'../'}),/超出/);
  await symlink(root,path.join(bot.workspaceDir,'outside'));
  await assert.rejects(browseBotFiles(bot.workspaceDir,refs,{source:'workspace',path:'outside'}),/超出/);
  await mkdir(path.join(bot.workspaceDir,'many'));
  for(let i=0;i<205;i++)await writeFile(path.join(bot.workspaceDir,'many',`${String(i).padStart(3,'0')}.txt`),'text');
  const first=await browseBotFiles(bot.workspaceDir,refs,{source:'workspace',path:'many'});const second=await browseBotFiles(bot.workspaceDir,refs,{source:'workspace',path:'many',offset:200});
  assert.equal(first.total,205);assert.equal(first.entries.length,200);assert.equal(second.entries.length,5);
  const recent=await browseBotFiles(bot.workspaceDir,refs,{source:'all',recentKeys:['workspace:notes/结论.md',`library:${own.id}`,'workspace:missing.txt']});
  assert.deepEqual(recent.entries.map(item=>item.name),['结论.md','论文.pdf']);
});

test('settings compare saved values rather than field visits and preserve blank stored keys', () => {
  const saved={model:'model',baseUrl:'http://localhost',apiKey:'',realtimeKey:'',locale:'zh'};
  assert.equal(hasUnsavedSettings({...saved,model:' model '},saved),false);
  assert.equal(hasUnsavedSettings({...saved,apiKey:'   '},saved),false);
  assert.equal(hasUnsavedSettings({...saved,model:'changed'},saved),true);
  assert.equal(hasUnsavedSettings({...saved,locale:'en'},saved),true);
  assert.equal(hasUnsavedSettings({...saved,realtimeKey:'new-key'},saved),true);
  assert.equal(hasUnsavedSettings({...saved},saved),false);
});
