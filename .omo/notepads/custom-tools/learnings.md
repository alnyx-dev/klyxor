## Custom Tools Implementation (2026-07-20)

### Pattern: createTool factory
- createTool(name, description, parameters, handler) in src/tools.ts is the canonical way to create tools
- Handler receives positional args matching parameters.properties keys
- schema() returns the OpenAI function-calling schema format
- call(kwargs) maps kwargs to positional args and calls handler

### Config pattern
- Module-level state variables with getter/setter functions
- ConfigData interface for JSON serialization
- loadConfig reads + parses + validates; saveConfig writes
- New fields should be optional in ConfigData

### Shell argument interpolation
- Used {paramName} placeholder syntax in command strings
- Arguments are shell-escaped with single quotes
- execSync returns Buffer unless encoding utf-8 is specified
- Set maxBuffer 1MB to handle large outputs

### Integration point
- Custom tools load AFTER MCP tools in buildTools
- Only loaded when getCustomToolsEnabled() returns true
