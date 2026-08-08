-- Global hotkey to mute/unmute Mindcraft host TTS (ElevenLabs + system voices).
-- Hits the mindserver's POST /api/voice/mute, which toggles by default.
-- Load from ~/.hammerspoon/init.lua:
--   dofile("/Users/begin/code/mindcraft-experiments/tools/hammerspoon/mindcraft_mute.lua")

-- "localhost", not "127.0.0.1": the mindserver binds the hostname, which Node
-- resolves to ::1 only, so the IPv4 literal gets connection-refused.
local MUTE_URL = "http://localhost:8080/api/voice/mute"

hs.hotkey.bind({ "cmd", "shift" }, "M", function()
    hs.http.asyncPost(MUTE_URL, "", {}, function(code, body)
        if code ~= 200 then
            -- A negative code means the request never landed (server down).
            local reason = code < 0 and "not running" or ("HTTP " .. code)
            hs.alert.show("Mindcraft TTS: " .. reason)
            return
        end
        local ok, data = pcall(hs.json.decode, body or "")
        if not ok or type(data) ~= "table" then
            hs.alert.show("Mindcraft TTS: bad response")
            return
        end
        hs.alert.show(data.muted and "Mindcraft TTS muted" or "Mindcraft TTS unmuted")
    end)
end)
