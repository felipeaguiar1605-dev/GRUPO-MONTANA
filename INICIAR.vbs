Set WshShell = CreateObject("WScript.Shell")
Dim scriptDir
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

' Inicia o servidor Node.js minimizado
WshShell.Run "cmd /c cd /d """ & scriptDir & """ && node src/server.js", 7, False

' Aguarda 2 segundos para o servidor iniciar
WScript.Sleep 2000

' Abre o Chrome com a URL correta
WshShell.Run "chrome http://localhost:3002", 1, False
