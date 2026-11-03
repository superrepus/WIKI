import { expect,it } from "vitest"
import { findLlmPreset } from "@/components/settings/llm-presets"
import { resolveConfig,disabledLlmConfig } from "@/components/settings/preset-resolver"
import { resolveTaskLlmConfig,resolveProjectLlmConfig } from "./llm-task-routing"
import type { LlmConfig } from "@/stores/wiki-store"
const fallback:LlmConfig={provider:"custom",model:"user-model",apiKey:"USER_KEY",customEndpoint:"https://user.invalid/v1",ollamaUrl:"",maxContextSize:64000}
it("exposes an available built-in model without copying or allowing endpoint/key overrides",()=>{
  const preset=findLlmPreset("foxess-default",[])!
  expect(preset.managedCredential).toBe(true)
  const c=resolveConfig(preset,{apiKey:"TAMPERED_KEY",baseUrl:"https://other.invalid",model:"other",customHeaders:{Authorization:"TAMPERED"},maxContextSize:32000},fallback)
  expect(c.apiKey).toBe("__FOXESS_BUILTIN_CREDENTIAL__");expect(c.customEndpoint).toBe(preset.baseUrl);expect(c.model).toBe(preset.defaultModel)
  expect(c.customHeaders).toBeUndefined();expect(c.maxContextSize).toBe(32000)
  expect(disabledLlmConfig(c).apiKey).toBe("")
})
it("retains custom providers and resolves the protected preset through independent tasks and project overrides",()=>{
  const routing={chatPresetId:"foxess-default",ingestPresetId:null}
  expect(resolveTaskLlmConfig("chat",fallback,{},routing).apiKey).toBe("__FOXESS_BUILTIN_CREDENTIAL__")
  expect(resolveTaskLlmConfig("ingest",fallback,{},routing)).toBe(fallback)
  const custom=findLlmPreset("custom-user",[{id:"custom-user",label:"User"}])!
  expect(resolveConfig(custom,{apiKey:"USER_KEY",baseUrl:"https://custom.invalid/v1",model:"my-model"},fallback).apiKey).toBe("USER_KEY")
  expect(resolveProjectLlmConfig(fallback,{}, {enabled:true,presetId:"foxess-default",model:"ignored"}).apiKey).toBe("__FOXESS_BUILTIN_CREDENTIAL__")
})
