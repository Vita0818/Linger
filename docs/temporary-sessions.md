# Temporary sessions on macOS

Choose **New Temporary Session** in the Linger tray menu to open a disposable
local workspace. The Desktop uses the BYOK model endpoint already configured
for its local installation. The model credential is passed through an
owner-only file inside the temporary directory.

The temporary window starts its own local Linger services, Computer
connection, model gateway, runtime and desktop profile. Its chat messages, runtime
sessions and tool records are stored only in the temporary directory. Node
Services excludes the Memory and LLM Wiki roles and disables Agent memory in
this instance. Actions in an external app or browser use that app's own
history and settings. Files saved outside the temporary workspace remain
where you saved them.

Close the temporary window to finish the session. The supervisor stops its
local services before removing the temporary directory. If stopping fails,
it reports the failure and retains the directory for recovery. The temporary
workspace is created on demand. Starting its services and runtime can take a
few minutes.
