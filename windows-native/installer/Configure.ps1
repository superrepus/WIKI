param([switch]$Headless,[string]$ProjectPath,[string]$Name='设备资料知识库',[string]$SourcePath='',[string]$BaseUrl='',[string]$Model='',[string]$ApiKey='',[switch]$EnableAutoIngest,[string]$StatePath=(Join-Path $env:APPDATA 'com.llmwiki.app/app-state.json'))
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Initialize.ps1')
if($Headless){New-ManagedWiki -ProjectPath $ProjectPath -Name $Name -SourcePath $SourcePath -BaseUrl $BaseUrl -Model $Model -ApiKey $ApiKey -StatePath $StatePath -AutoIngest ([bool]$EnableAutoIngest);return}
Add-Type -AssemblyName PresentationFramework
if(Test-Path -LiteralPath $StatePath){[Windows.MessageBox]::Show('已检测到已有 FoxEss WIKI 配置，已保留。请在应用中打开已有知识库、设置模型或修改自动导入目录。','保留现有数据') | Out-Null;return}
if(Get-Process -Name llm-wiki -ErrorAction SilentlyContinue){[Windows.MessageBox]::Show('请先退出 FoxEss WIKI，再运行首次配置。','应用正在运行') | Out-Null;return}
[xml]$xaml=@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Title="FoxEss WIKI 首次配置" Width="660" Height="635" WindowStartupLocation="CenterScreen" ResizeMode="NoResize" Background="#F8FAFC">
 <StackPanel Margin="28">
  <TextBlock FontSize="24" FontWeight="Bold" Text="创建设备资料知识库"/>
  <TextBlock Margin="0,10,0,14" Name="IntroText" TextWrapping="Wrap" Text="共享盘资料保持只读，知识库保存在独立本地目录。请配置可用模型；也可先创建项目，再在应用设置中添加模型。"/>
  <TextBlock Text="知识库名称"/><TextBox Name="ProjectName" Margin="0,4,0,10" Padding="6" Text="设备资料知识库"/>
  <TextBlock Text="新知识库本地目录（必须为空，不要放在程序或共享来源目录中）"/><TextBox Name="ProjectPath" Margin="0,4,0,10" Padding="6"/>
  <TextBlock Text="共享来源目录（可留空，使用当前 Windows 账号权限）"/><TextBox Name="SourcePath" Margin="0,4,0,10" Padding="6"/>
  <TextBlock Text="模型 Base URL（可先留空，后续在应用中配置）"/><TextBox Name="BaseUrl" Margin="0,4,0,10" Padding="6"/>
  <TextBlock Text="模型名称"/><TextBox Name="Model" Margin="0,4,0,10" Padding="6"/>
  <TextBlock Text="模型 API Key（保存在本机应用配置中）"/><PasswordBox Name="ApiKey" Margin="0,4,0,12" Padding="6"/>
  <CheckBox Name="AutoIngest" Content="配置完成后自动入库（会立即调用模型；默认关闭）" Margin="0,0,0,14"/>
  <TextBlock Name="ErrorText" Foreground="#B91C1C" TextWrapping="Wrap" MaxHeight="45"/>
  <Button Name="Create" Content="保存并打开 FoxEss WIKI" Padding="12,8" HorizontalAlignment="Right"/>
 </StackPanel>
</Window>
'@
$dialog=[Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $xaml))
$defaultModelMeta=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'foxess-default-model.json'),[Text.Encoding]::UTF8) | ConvertFrom-Json
$hasBuiltinCredential=!(($defaultModelMeta.PSObject.Properties.Name -contains 'credentialIncluded') -and !$defaultModelMeta.credentialIncluded)
if($hasBuiltinCredential){$dialog.FindName('IntroText').Text='共享盘资料保持只读，知识库保存在独立本地目录。此企业构建已内置默认模型，首次使用可留空模型；也可填写自己的服务。'}
$dialog.FindName('ProjectPath').Text=Join-Path $env:LOCALAPPDATA 'FoxESS/LLMWiki/Data/equipment-wiki'
$dialog.FindName('Create').Add_Click({
  try{
    $result=New-ManagedWiki -ProjectPath $dialog.FindName('ProjectPath').Text -Name $dialog.FindName('ProjectName').Text -SourcePath $dialog.FindName('SourcePath').Text -BaseUrl $dialog.FindName('BaseUrl').Text -Model $dialog.FindName('Model').Text -ApiKey $dialog.FindName('ApiKey').Password -StatePath $StatePath -AutoIngest ([bool]$dialog.FindName('AutoIngest').IsChecked)
    $dialog.DialogResult=$true
  }catch{$dialog.FindName('ErrorText').Text=$_.Exception.Message}
})
if($dialog.ShowDialog()) { & (Join-Path $PSScriptRoot 'Start.ps1') }
