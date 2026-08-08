#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>

#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define CBJ_PROTOCOL_W L"1"
#define CBJ_PROTOCOL_A "1"
#define CBJ_MAX_CONTROL_LINE 512
#define CBJ_MAX_COMMAND_LINE 32766
#define CBJ_MAX_TIMEOUT_MS 3600000UL
#define CBJ_CONTROL_CONNECT_MS 5000UL
#define CBJ_JOB_DRAIN_MS 2000UL

#define CBD_PROTOCOL_W L"2"
#define CBD_MAX_PATH_UNITS 32766U

typedef enum cbj_cancel_reason {
  CBJ_CANCEL_NONE = 0,
  CBJ_CANCEL_TIMEOUT = 1,
  CBJ_CANCEL_OUTPUT_LIMIT = 2,
  CBJ_CANCEL_SIGNAL = 3,
  CBJ_CANCEL_CALLER = 4,
  CBJ_CANCEL_PARENT_DEATH = 5,
  CBJ_CANCEL_PROTOCOL = 6
} cbj_cancel_reason;

typedef struct cbj_monitor_context {
  HANDLE control;
  HANDLE cancelled;
  volatile LONG reason;
  volatile LONG shutting_down;
} cbj_monitor_context;

static const char *cbj_reason_name(cbj_cancel_reason reason) {
  switch (reason) {
    case CBJ_CANCEL_TIMEOUT: return "timeout";
    case CBJ_CANCEL_OUTPUT_LIMIT: return "output_limit";
    case CBJ_CANCEL_SIGNAL: return "signal";
    case CBJ_CANCEL_CALLER: return "caller";
    case CBJ_CANCEL_PARENT_DEATH: return "parent_death";
    case CBJ_CANCEL_PROTOCOL: return "protocol";
    default: return "protocol";
  }
}

static BOOL cbj_is_hex_token(const wchar_t *value) {
  size_t index;
  if (value == NULL || wcslen(value) != 64U) return FALSE;
  for (index = 0U; index < 64U; index += 1U) {
    wchar_t character = value[index];
    if (!((character >= L'0' && character <= L'9')
        || (character >= L'a' && character <= L'f'))) return FALSE;
  }
  return TRUE;
}

static BOOL cbj_is_drive_file_path(const wchar_t *value) {
  return value != NULL
    && ((value[0] >= L'A' && value[0] <= L'Z')
      || (value[0] >= L'a' && value[0] <= L'z'))
    && value[1] == L':'
    && (value[2] == L'\\' || value[2] == L'/')
    && value[3] != L'\0';
}

static BOOL cbj_is_absolute_application_path(const wchar_t *value) {
  if (cbj_is_drive_file_path(value)) return TRUE;
  return value != NULL
    && value[0] == L'\\'
    && value[1] == L'\\'
    && value[2] == L'?'
    && value[3] == L'\\'
    && cbj_is_drive_file_path(value + 4);
}

static BOOL cbj_ascii_from_wide(const wchar_t *value, char *output, size_t output_size) {
  size_t index;
  size_t length;
  if (value == NULL || output == NULL || output_size == 0U) return FALSE;
  length = wcslen(value);
  if (length + 1U > output_size) return FALSE;
  for (index = 0U; index < length; index += 1U) {
    if (value[index] < 0x20 || value[index] > 0x7e) return FALSE;
    output[index] = (char)value[index];
  }
  output[length] = '\0';
  return TRUE;
}

static BOOL cbj_parse_timeout(const wchar_t *value, DWORD *timeout_ms) {
  wchar_t *end = NULL;
  unsigned long parsed;
  if (value == NULL || timeout_ms == NULL || value[0] == L'\0' || value[0] == L'-') return FALSE;
  parsed = wcstoul(value, &end, 10);
  if (end == NULL || *end != L'\0' || parsed < 1UL || parsed > CBJ_MAX_TIMEOUT_MS) return FALSE;
  *timeout_ms = (DWORD)parsed;
  return TRUE;
}

static BOOL cbj_write_all(HANDLE handle, const char *bytes, DWORD length) {
  DWORD offset = 0U;
  while (offset < length) {
    DWORD written = 0U;
    if (!WriteFile(handle, bytes + offset, length - offset, &written, NULL) || written == 0U) return FALSE;
    offset += written;
  }
  return TRUE;
}

static BOOL cbj_write_record(HANDLE control, const char *record) {
  char buffer[CBJ_MAX_CONTROL_LINE];
  int length = _snprintf_s(
    buffer,
    sizeof(buffer),
    _TRUNCATE,
    "CBJ %s %s\n",
    CBJ_PROTOCOL_A,
    record
  );
  if (length < 0 || length >= (int)sizeof(buffer)) return FALSE;
  return cbj_write_all(control, buffer, (DWORD)length);
}

static BOOL cbj_write_error(HANDLE control, const char *stage, DWORD error_code) {
  char record[CBJ_MAX_CONTROL_LINE];
  int length = _snprintf_s(record, sizeof(record), _TRUNCATE, "ERROR %s %lu", stage, error_code);
  if (length < 0 || length >= (int)sizeof(record)) return FALSE;
  return cbj_write_record(control, record);
}

static BOOL cbj_write_ready(HANDLE control, DWORD process_id) {
  char record[64];
  int length = _snprintf_s(record, sizeof(record), _TRUNCATE, "READY %lu", process_id);
  if (length < 0 || length >= (int)sizeof(record)) return FALSE;
  return cbj_write_record(control, record);
}

static BOOL cbj_write_exit(HANDLE control, DWORD exit_code) {
  char record[64];
  int length = _snprintf_s(record, sizeof(record), _TRUNCATE, "EXIT %lu", exit_code);
  if (length < 0 || length >= (int)sizeof(record)) return FALSE;
  return cbj_write_record(control, record);
}

static BOOL cbj_write_terminated(HANDLE control, cbj_cancel_reason reason) {
  char record[96];
  int length = _snprintf_s(
    record,
    sizeof(record),
    _TRUNCATE,
    "TERMINATED %s",
    cbj_reason_name(reason)
  );
  if (length < 0 || length >= (int)sizeof(record)) return FALSE;
  return cbj_write_record(control, record);
}

/* Returns 1 for one complete line, 0 for EOF, and -1 for an invalid/error line. */
static int cbj_read_line(HANDLE control, char *line, DWORD capacity) {
  DWORD length = 0U;
  if (line == NULL || capacity < 2U) return -1;
  for (;;) {
    char character = '\0';
    DWORD read = 0U;
    if (!ReadFile(control, &character, 1U, &read, NULL)) {
      DWORD error_code = GetLastError();
      if (error_code == ERROR_BROKEN_PIPE || error_code == ERROR_PIPE_NOT_CONNECTED
          || error_code == ERROR_OPERATION_ABORTED) return 0;
      return -1;
    }
    if (read == 0U) return 0;
    if (character == '\n') {
      line[length] = '\0';
      return 1;
    }
    if (character < 0x20 || character > 0x7e || length + 1U >= capacity) return -1;
    line[length] = character;
    length += 1U;
  }
}

/* The monitor uses bounded polling so shutdown cannot race into a blocking ReadFile. */
static int cbj_read_monitored_line(cbj_monitor_context *context, char *line, DWORD capacity) {
  DWORD length = 0U;
  if (context == NULL || line == NULL || capacity < 2U) return -1;
  for (;;) {
    DWORD available = 0U;
    char character = '\0';
    DWORD read = 0U;
    if (InterlockedCompareExchange(&context->shutting_down, 0L, 0L) != 0L) return -2;
    if (!PeekNamedPipe(context->control, NULL, 0U, NULL, &available, NULL)) {
      DWORD error_code = GetLastError();
      if (error_code == ERROR_BROKEN_PIPE || error_code == ERROR_PIPE_NOT_CONNECTED) return 0;
      return -1;
    }
    if (available == 0U) {
      Sleep(5U);
      continue;
    }
    if (!ReadFile(context->control, &character, 1U, &read, NULL)) {
      DWORD error_code = GetLastError();
      if (error_code == ERROR_BROKEN_PIPE || error_code == ERROR_PIPE_NOT_CONNECTED
          || error_code == ERROR_OPERATION_ABORTED) return 0;
      return -1;
    }
    if (read == 0U) return 0;
    if (character == '\n') {
      line[length] = '\0';
      return 1;
    }
    if (character < 0x20 || character > 0x7e || length + 1U >= capacity) return -1;
    line[length] = character;
    length += 1U;
  }
}

static HANDLE cbj_connect_control(const wchar_t *pipe_name, DWORD *last_error) {
  ULONGLONG started = GetTickCount64();
  for (;;) {
    HANDLE control = CreateFileW(
      pipe_name,
      GENERIC_READ | GENERIC_WRITE,
      0U,
      NULL,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL,
      NULL
    );
    if (control != INVALID_HANDLE_VALUE) return control;
    *last_error = GetLastError();
    if (*last_error != ERROR_PIPE_BUSY && *last_error != ERROR_FILE_NOT_FOUND) return INVALID_HANDLE_VALUE;
    if (GetTickCount64() - started >= CBJ_CONTROL_CONNECT_MS) return INVALID_HANDLE_VALUE;
    if (*last_error == ERROR_PIPE_BUSY) (void)WaitNamedPipeW(pipe_name, 100U);
    else Sleep(20U);
  }
}

static BOOL cbj_append_character(wchar_t *buffer, size_t *length, wchar_t character) {
  if (*length >= CBJ_MAX_COMMAND_LINE) return FALSE;
  buffer[*length] = character;
  *length += 1U;
  return TRUE;
}

static BOOL cbj_append_repeated(wchar_t *buffer, size_t *length, wchar_t character, size_t count) {
  size_t index;
  for (index = 0U; index < count; index += 1U) {
    if (!cbj_append_character(buffer, length, character)) return FALSE;
  }
  return TRUE;
}

static BOOL cbj_append_quoted_argument(wchar_t *buffer, size_t *length, const wchar_t *argument) {
  size_t index = 0U;
  size_t backslashes = 0U;
  if (!cbj_append_character(buffer, length, L'"')) return FALSE;
  while (argument[index] != L'\0') {
    wchar_t character = argument[index];
    if (character == L'\\') {
      backslashes += 1U;
      index += 1U;
      continue;
    }
    if (character == L'"') {
      if (backslashes > (SIZE_MAX - 1U) / 2U) return FALSE;
      if (!cbj_append_repeated(buffer, length, L'\\', (backslashes * 2U) + 1U)) return FALSE;
      if (!cbj_append_character(buffer, length, L'"')) return FALSE;
      backslashes = 0U;
      index += 1U;
      continue;
    }
    if (!cbj_append_repeated(buffer, length, L'\\', backslashes)) return FALSE;
    backslashes = 0U;
    if (!cbj_append_character(buffer, length, character)) return FALSE;
    index += 1U;
  }
  if (backslashes > SIZE_MAX / 2U) return FALSE;
  if (!cbj_append_repeated(buffer, length, L'\\', backslashes * 2U)) return FALSE;
  return cbj_append_character(buffer, length, L'"');
}

static wchar_t *cbj_build_command_line(int argc, wchar_t **argv, int first_provider_arg) {
  wchar_t *command_line;
  size_t length = 0U;
  int index;
  command_line = (wchar_t *)HeapAlloc(
    GetProcessHeap(),
    HEAP_ZERO_MEMORY,
    (CBJ_MAX_COMMAND_LINE + 1U) * sizeof(wchar_t)
  );
  if (command_line == NULL) return NULL;
  for (index = first_provider_arg; index < argc; index += 1) {
    if (index > first_provider_arg && !cbj_append_character(command_line, &length, L' ')) goto invalid;
    if (!cbj_append_quoted_argument(command_line, &length, argv[index])) goto invalid;
  }
  command_line[length] = L'\0';
  return command_line;

invalid:
  HeapFree(GetProcessHeap(), 0U, command_line);
  SetLastError(ERROR_BAD_LENGTH);
  return NULL;
}

static BOOL cbj_duplicate_inheritable(HANDLE source, HANDLE *duplicate) {
  if (source == NULL || source == INVALID_HANDLE_VALUE) {
    SetLastError(ERROR_INVALID_HANDLE);
    return FALSE;
  }
  return DuplicateHandle(
    GetCurrentProcess(),
    source,
    GetCurrentProcess(),
    duplicate,
    0U,
    TRUE,
    DUPLICATE_SAME_ACCESS
  );
}

static void cbj_set_reason(cbj_monitor_context *context, cbj_cancel_reason reason) {
  if (InterlockedCompareExchange(&context->reason, (LONG)reason, (LONG)CBJ_CANCEL_NONE)
      == (LONG)CBJ_CANCEL_NONE) {
    SetEvent(context->cancelled);
  }
}

static cbj_cancel_reason cbj_parse_cancel_record(const char *line) {
  static const char prefix[] = "CBJ " CBJ_PROTOCOL_A " CANCEL ";
  const char *reason;
  if (strncmp(line, prefix, sizeof(prefix) - 1U) != 0) return CBJ_CANCEL_PROTOCOL;
  reason = line + sizeof(prefix) - 1U;
  if (strcmp(reason, "timeout") == 0) return CBJ_CANCEL_TIMEOUT;
  if (strcmp(reason, "output_limit") == 0) return CBJ_CANCEL_OUTPUT_LIMIT;
  if (strcmp(reason, "signal") == 0) return CBJ_CANCEL_SIGNAL;
  if (strcmp(reason, "caller") == 0) return CBJ_CANCEL_CALLER;
  return CBJ_CANCEL_PROTOCOL;
}

static DWORD WINAPI cbj_monitor_parent(LPVOID parameter) {
  cbj_monitor_context *context = (cbj_monitor_context *)parameter;
  char line[CBJ_MAX_CONTROL_LINE];
  int result = cbj_read_monitored_line(context, line, (DWORD)sizeof(line));
  if (InterlockedCompareExchange(&context->shutting_down, 0L, 0L) != 0L) return 0U;
  if (result == 0) cbj_set_reason(context, CBJ_CANCEL_PARENT_DEATH);
  else if (result < 0) cbj_set_reason(context, CBJ_CANCEL_PROTOCOL);
  else cbj_set_reason(context, cbj_parse_cancel_record(line));
  return 0U;
}

static BOOL cbj_terminate_and_drain_job(HANDLE job, UINT exit_code, DWORD *error_code) {
  ULONGLONG started;
  if (!TerminateJobObject(job, exit_code)) {
    *error_code = GetLastError();
    return FALSE;
  }
  started = GetTickCount64();
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    ZeroMemory(&accounting, sizeof(accounting));
    if (!QueryInformationJobObject(
          job,
          JobObjectBasicAccountingInformation,
          &accounting,
          (DWORD)sizeof(accounting),
          NULL)) {
      *error_code = GetLastError();
      return FALSE;
    }
    if (accounting.ActiveProcesses == 0U) return TRUE;
    if (GetTickCount64() - started >= CBJ_JOB_DRAIN_MS) {
      *error_code = WAIT_TIMEOUT;
      return FALSE;
    }
    Sleep(10U);
  }
}

typedef struct cbd_json_buffer {
  char *data;
  size_t length;
  size_t capacity;
} cbd_json_buffer;

static BOOL cbd_json_reserve(cbd_json_buffer *buffer, size_t extra) {
  size_t required;
  size_t capacity;
  char *resized;
  if (buffer == NULL || extra > SIZE_MAX - buffer->length - 1U) return FALSE;
  required = buffer->length + extra + 1U;
  if (required <= buffer->capacity) return TRUE;
  capacity = buffer->capacity == 0U ? 1024U : buffer->capacity;
  while (capacity < required) {
    if (capacity > SIZE_MAX / 2U) {
      capacity = required;
      break;
    }
    capacity *= 2U;
  }
  if (buffer->data == NULL) {
    resized = (char *)HeapAlloc(GetProcessHeap(), 0U, capacity);
  } else {
    resized = (char *)HeapReAlloc(GetProcessHeap(), 0U, buffer->data, capacity);
  }
  if (resized == NULL) return FALSE;
  buffer->data = resized;
  buffer->capacity = capacity;
  return TRUE;
}

static BOOL cbd_json_append_bytes(cbd_json_buffer *buffer, const char *value, size_t length) {
  if (!cbd_json_reserve(buffer, length)) return FALSE;
  if (length != 0U) memcpy(buffer->data + buffer->length, value, length);
  buffer->length += length;
  buffer->data[buffer->length] = '\0';
  return TRUE;
}

static BOOL cbd_json_append_ascii(cbd_json_buffer *buffer, const char *value) {
  return value != NULL && cbd_json_append_bytes(buffer, value, strlen(value));
}

static BOOL cbd_json_append_quoted_wide(cbd_json_buffer *buffer, const wchar_t *value) {
  static const char hex[] = "0123456789abcdef";
  char *utf8;
  int utf8_size;
  int index;
  BOOL success = FALSE;
  if (value == NULL || !cbd_json_append_ascii(buffer, "\"")) return FALSE;
  utf8_size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, NULL, 0, NULL, NULL);
  if (utf8_size <= 0) return FALSE;
  utf8 = (char *)HeapAlloc(GetProcessHeap(), 0U, (SIZE_T)utf8_size);
  if (utf8 == NULL) return FALSE;
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, utf8, utf8_size, NULL, NULL) <= 0) {
    goto cleanup;
  }
  for (index = 0; index < utf8_size - 1; index += 1) {
    unsigned char character = (unsigned char)utf8[index];
    if (character == '"' || character == '\\') {
      char escaped[2] = { '\\', (char)character };
      if (!cbd_json_append_bytes(buffer, escaped, sizeof(escaped))) goto cleanup;
    } else if (character < 0x20U) {
      char escaped[6] = { '\\', 'u', '0', '0', hex[character >> 4U], hex[character & 0x0fU] };
      if (!cbd_json_append_bytes(buffer, escaped, sizeof(escaped))) goto cleanup;
    } else if (!cbd_json_append_bytes(buffer, (const char *)&utf8[index], 1U)) {
      goto cleanup;
    }
  }
  success = cbd_json_append_ascii(buffer, "\"");

cleanup:
  HeapFree(GetProcessHeap(), 0U, utf8);
  return success;
}

static BOOL cbd_json_append_uint(cbd_json_buffer *buffer, DWORD value) {
  char number[32];
  int length = _snprintf_s(number, sizeof(number), _TRUNCATE, "%lu", value);
  return length >= 0 && cbd_json_append_bytes(buffer, number, (size_t)length);
}

static BOOL cbd_emit_buffer(cbd_json_buffer *buffer) {
  BOOL success;
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (buffer == NULL || buffer->data == NULL || output == NULL || output == INVALID_HANDLE_VALUE) return FALSE;
  success = cbd_json_append_ascii(buffer, "\n")
    && cbj_write_all(output, buffer->data, (DWORD)buffer->length);
  HeapFree(GetProcessHeap(), 0U, buffer->data);
  buffer->data = NULL;
  return success;
}

static BOOL cbd_emit_failure(
    const wchar_t *op,
    const wchar_t *path,
    const char *code,
    const wchar_t *message,
    DWORD win32_error) {
  cbd_json_buffer buffer;
  BOOL success;
  ZeroMemory(&buffer, sizeof(buffer));
  success = cbd_json_append_ascii(&buffer, "{\"ok\":false,\"op\":")
    && cbd_json_append_quoted_wide(&buffer, op != NULL ? op : L"unknown");
  if (success && path != NULL) {
    success = cbd_json_append_ascii(&buffer, ",\"path\":")
      && cbd_json_append_quoted_wide(&buffer, path);
  }
  success = success
    && cbd_json_append_ascii(&buffer, ",\"code\":\"")
    && cbd_json_append_ascii(&buffer, code)
    && cbd_json_append_ascii(&buffer, "\",\"message\":")
    && cbd_json_append_quoted_wide(&buffer, message)
    && cbd_json_append_ascii(&buffer, ",\"win32_error\":")
    && cbd_json_append_uint(&buffer, win32_error)
    && cbd_json_append_ascii(&buffer, ",\"protocol\":2}");
  if (!success) {
    if (buffer.data != NULL) HeapFree(GetProcessHeap(), 0U, buffer.data);
    return FALSE;
  }
  return cbd_emit_buffer(&buffer);
}

static BOOL cbd_emit_owner_success(const wchar_t *op, const wchar_t *path, const wchar_t *owner_sid) {
  cbd_json_buffer buffer;
  BOOL success;
  ZeroMemory(&buffer, sizeof(buffer));
  success = cbd_json_append_ascii(&buffer, "{\"ok\":true,\"op\":")
    && cbd_json_append_quoted_wide(&buffer, op)
    && cbd_json_append_ascii(&buffer, ",\"path\":")
    && cbd_json_append_quoted_wide(&buffer, path)
    && cbd_json_append_ascii(&buffer, ",\"owner_sid\":")
    && cbd_json_append_quoted_wide(&buffer, owner_sid)
    && cbd_json_append_ascii(&buffer, ",\"protocol\":2}");
  if (!success) {
    if (buffer.data != NULL) HeapFree(GetProcessHeap(), 0U, buffer.data);
    return FALSE;
  }
  return cbd_emit_buffer(&buffer);
}

static BOOL cbd_emit_filesystem_success(const wchar_t *op, const wchar_t *path) {
  cbd_json_buffer buffer;
  BOOL success;
  ZeroMemory(&buffer, sizeof(buffer));
  success = cbd_json_append_ascii(&buffer, "{\"ok\":true,\"op\":")
    && cbd_json_append_quoted_wide(&buffer, op)
    && cbd_json_append_ascii(&buffer, ",\"path\":")
    && cbd_json_append_quoted_wide(&buffer, path)
    && cbd_json_append_ascii(&buffer, ",\"filesystem_acl_capable\":true,\"protocol\":2}");
  if (!success) {
    if (buffer.data != NULL) HeapFree(GetProcessHeap(), 0U, buffer.data);
    return FALSE;
  }
  return cbd_emit_buffer(&buffer);
}

static BOOL cbd_emit_protocol_info(const wchar_t *op) {
  cbd_json_buffer buffer;
  BOOL success;
  ZeroMemory(&buffer, sizeof(buffer));
  success = cbd_json_append_ascii(&buffer, "{\"ok\":true,\"op\":")
    && cbd_json_append_quoted_wide(&buffer, op)
    && cbd_json_append_ascii(
      &buffer,
      ",\"job_protocol\":1,\"dacl_protocol\":2,\"protocol\":2}"
    );
  if (!success) {
    if (buffer.data != NULL) HeapFree(GetProcessHeap(), 0U, buffer.data);
    return FALSE;
  }
  return cbd_emit_buffer(&buffer);
}

static BOOL cbd_is_unc_path(const wchar_t *path) {
  size_t length = path == NULL ? 0U : wcslen(path);
  return length >= 2U && path[0] == L'\\' && path[1] == L'\\'
    && !(length >= 7U && path[2] == L'?' && path[3] == L'\\'
      && cbj_is_drive_file_path(path + 4));
}

static BOOL cbd_is_absolute_drive_path(const wchar_t *path) {
  size_t length = path == NULL ? 0U : wcslen(path);
  if (length >= 3U
      && ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z'))
      && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) return TRUE;
  return length >= 7U
    && path[0] == L'\\' && path[1] == L'\\' && path[2] == L'?' && path[3] == L'\\'
    && ((path[4] >= L'A' && path[4] <= L'Z') || (path[4] >= L'a' && path[4] <= L'z'))
    && path[5] == L':' && (path[6] == L'\\' || path[6] == L'/');
}

static BOOL cbd_path_length_valid(const wchar_t *path) {
  return path != NULL && wcslen(path) <= CBD_MAX_PATH_UNITS;
}

static const char *cbd_path_error_code(DWORD error_code, const char *fallback) {
  if (error_code == ERROR_FILENAME_EXCED_RANGE || error_code == ERROR_BUFFER_OVERFLOW) {
    return "path_too_long";
  }
  return fallback;
}

static BOOL cbd_volume_supports_acls(const wchar_t *path, DWORD *error_code) {
  wchar_t root[8];
  DWORD flags = 0U;
  if (path[0] == L'\\') {
    root[0] = L'\\'; root[1] = L'\\'; root[2] = L'?'; root[3] = L'\\';
    root[4] = path[4]; root[5] = L':'; root[6] = L'\\'; root[7] = L'\0';
  } else {
    root[0] = path[0]; root[1] = L':'; root[2] = L'\\'; root[3] = L'\0';
  }
  if (!GetVolumeInformationW(root, NULL, 0U, NULL, NULL, &flags, NULL, 0U)) {
    *error_code = GetLastError();
    return FALSE;
  }
  if ((flags & FILE_PERSISTENT_ACLS) == 0U) {
    *error_code = ERROR_NOT_SUPPORTED;
    return FALSE;
  }
  *error_code = ERROR_SUCCESS;
  return TRUE;
}

static BOOL cbd_get_current_user(PTOKEN_USER *token_user, DWORD *error_code) {
  HANDLE token = NULL;
  DWORD bytes = 0U;
  PTOKEN_USER value = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    *error_code = GetLastError();
    return FALSE;
  }
  (void)GetTokenInformation(token, TokenUser, NULL, 0U, &bytes);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || bytes == 0U) {
    *error_code = GetLastError();
    CloseHandle(token);
    return FALSE;
  }
  value = (PTOKEN_USER)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, bytes);
  if (value == NULL) {
    *error_code = ERROR_NOT_ENOUGH_MEMORY;
    CloseHandle(token);
    return FALSE;
  }
  if (!GetTokenInformation(token, TokenUser, value, bytes, &bytes)) {
    *error_code = GetLastError();
    HeapFree(GetProcessHeap(), 0U, value);
    CloseHandle(token);
    return FALSE;
  }
  CloseHandle(token);
  *token_user = value;
  *error_code = ERROR_SUCCESS;
  return TRUE;
}

static BOOL cbd_create_required_sids(
    BYTE *system_sid,
    DWORD *system_size,
    BYTE *administrators_sid,
    DWORD *administrators_size,
    DWORD *error_code) {
  if (!CreateWellKnownSid(WinLocalSystemSid, NULL, system_sid, system_size)
      || !CreateWellKnownSid(
        WinBuiltinAdministratorsSid,
        NULL,
        administrators_sid,
        administrators_size
      )) {
    *error_code = GetLastError();
    return FALSE;
  }
  return TRUE;
}

static BOOL cbd_open_leaf(
    const wchar_t *path,
    BOOL directory,
    HANDLE *handle,
    FILE_ATTRIBUTE_TAG_INFO *tag,
    const char **failure_code,
    DWORD *error_code) {
  HANDLE opened = CreateFileW(
    path,
    FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL,
    OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
    NULL
  );
  if (opened == INVALID_HANDLE_VALUE) {
    *error_code = GetLastError();
    *failure_code = cbd_path_error_code(*error_code, "open_failed");
    return FALSE;
  }
  if (!GetFileInformationByHandleEx(opened, FileAttributeTagInfo, tag, (DWORD)sizeof(*tag))) {
    *failure_code = "open_failed";
    *error_code = GetLastError();
    CloseHandle(opened);
    return FALSE;
  }
  if ((tag->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0U) {
    *failure_code = "reparse_point";
    *error_code = ERROR_REPARSE_TAG_INVALID;
    CloseHandle(opened);
    return FALSE;
  }
  if (directory && (tag->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0U) {
    *failure_code = "not_a_directory";
    *error_code = ERROR_DIRECTORY;
    CloseHandle(opened);
    return FALSE;
  }
  if (!directory && (tag->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0U) {
    *failure_code = "not_a_file";
    *error_code = ERROR_FILE_INVALID;
    CloseHandle(opened);
    return FALSE;
  }
  *handle = opened;
  return TRUE;
}

static BOOL cbd_build_private_security(
    BOOL directory,
    PTOKEN_USER *token_user,
    PACL *dacl,
    PSECURITY_DESCRIPTOR descriptor,
    DWORD *error_code) {
  BYTE system_sid[SECURITY_MAX_SID_SIZE];
  BYTE administrators_sid[SECURITY_MAX_SID_SIZE];
  DWORD system_size = sizeof(system_sid);
  DWORD administrators_size = sizeof(administrators_sid);
  EXPLICIT_ACCESSW entries[3];
  DWORD result;
  if (!cbd_get_current_user(token_user, error_code)) return FALSE;
  if (!cbd_create_required_sids(
        system_sid,
        &system_size,
        administrators_sid,
        &administrators_size,
        error_code)) return FALSE;
  ZeroMemory(entries, sizeof(entries));
  entries[0].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entries[0].Trustee.TrusteeType = TRUSTEE_IS_USER;
  entries[0].Trustee.ptstrName = (LPWSTR)(*token_user)->User.Sid;
  entries[1].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entries[1].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  entries[1].Trustee.ptstrName = (LPWSTR)system_sid;
  entries[2].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entries[2].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  entries[2].Trustee.ptstrName = (LPWSTR)administrators_sid;
  for (result = 0U; result < 3U; result += 1U) {
    entries[result].grfAccessPermissions = FILE_ALL_ACCESS;
    entries[result].grfAccessMode = SET_ACCESS;
    entries[result].grfInheritance = directory
      ? SUB_CONTAINERS_AND_OBJECTS_INHERIT
      : NO_INHERITANCE;
  }
  result = SetEntriesInAclW(3U, entries, NULL, dacl);
  if (result != ERROR_SUCCESS) {
    *error_code = result;
    return FALSE;
  }
  if (!InitializeSecurityDescriptor(descriptor, SECURITY_DESCRIPTOR_REVISION)
      || !SetSecurityDescriptorOwner(descriptor, (*token_user)->User.Sid, FALSE)
      || !SetSecurityDescriptorDacl(descriptor, TRUE, *dacl, FALSE)
      || !SetSecurityDescriptorControl(
        descriptor,
        SE_DACL_PROTECTED,
        SE_DACL_PROTECTED
      )) {
    *error_code = GetLastError();
    return FALSE;
  }
  return TRUE;
}

static BOOL cbd_set_private_security(const wchar_t *path, BOOL directory, DWORD *error_code) {
  PTOKEN_USER token_user = NULL;
  PACL dacl = NULL;
  SECURITY_DESCRIPTOR descriptor;
  HANDLE leaf = INVALID_HANDLE_VALUE;
  FILE_ATTRIBUTE_TAG_INFO tag;
  DWORD result;
  BOOL success = FALSE;
  const char *failure_code = "open_failed";
  if (!cbd_build_private_security(
        directory,
        &token_user,
        &dacl,
        &descriptor,
        error_code)) goto cleanup;
  leaf = CreateFileW(
    path,
    READ_CONTROL | WRITE_DAC | WRITE_OWNER,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL,
    OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
    NULL
  );
  if (leaf == INVALID_HANDLE_VALUE) {
    *error_code = GetLastError();
    goto cleanup;
  }
  if (!GetFileInformationByHandleEx(leaf, FileAttributeTagInfo, &tag, (DWORD)sizeof(tag))) {
    *error_code = GetLastError();
    goto cleanup;
  }
  if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0U) {
    *error_code = ERROR_REPARSE_TAG_INVALID;
    goto cleanup;
  }
  result = SetSecurityInfo(
    leaf,
    SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
    token_user->User.Sid,
    NULL,
    dacl,
    NULL
  );
  if (result != ERROR_SUCCESS) {
    *error_code = result;
    goto cleanup;
  }
  success = TRUE;

cleanup:
  if (leaf != INVALID_HANDLE_VALUE) CloseHandle(leaf);
  if (dacl != NULL) LocalFree(dacl);
  if (token_user != NULL) HeapFree(GetProcessHeap(), 0U, token_user);
  (void)failure_code;
  return success;
}

static BOOL cbd_create_private_leaf(
    const wchar_t *path,
    BOOL directory,
    const char **failure_code,
    DWORD *error_code) {
  PTOKEN_USER token_user = NULL;
  PACL dacl = NULL;
  SECURITY_DESCRIPTOR descriptor;
  SECURITY_ATTRIBUTES security;
  HANDLE file = INVALID_HANDLE_VALUE;
  BOOL success = FALSE;
  if (!cbd_build_private_security(
        directory,
        &token_user,
        &dacl,
        &descriptor,
        error_code)) {
    *failure_code = "set_security_failed";
    goto cleanup;
  }
  security.nLength = sizeof(security);
  security.lpSecurityDescriptor = &descriptor;
  security.bInheritHandle = FALSE;
  if (directory) {
    if (!CreateDirectoryW(path, &security)) {
      *error_code = GetLastError();
      *failure_code = cbd_path_error_code(*error_code, "create_failed");
      goto cleanup;
    }
  } else {
    file = CreateFileW(
      path,
      GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      &security,
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL,
      NULL
    );
    if (file == INVALID_HANDLE_VALUE) {
      *error_code = GetLastError();
      *failure_code = cbd_path_error_code(*error_code, "create_failed");
      goto cleanup;
    }
    CloseHandle(file);
    file = INVALID_HANDLE_VALUE;
  }
  success = TRUE;

cleanup:
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  if (dacl != NULL) LocalFree(dacl);
  if (token_user != NULL) HeapFree(GetProcessHeap(), 0U, token_user);
  return success;
}

static BOOL cbd_sid_index(PSID sid, PSID user, PSID system, PSID administrators, DWORD *index) {
  if (EqualSid(sid, user)) *index = 0U;
  else if (EqualSid(sid, system)) *index = 1U;
  else if (EqualSid(sid, administrators)) *index = 2U;
  else return FALSE;
  return TRUE;
}

static BOOL cbd_verify_private_security(
    const wchar_t *path,
    BOOL directory,
    wchar_t **owner_text,
    const char **failure_code,
    DWORD *error_code) {
  HANDLE leaf = INVALID_HANDLE_VALUE;
  HANDLE reopened = INVALID_HANDLE_VALUE;
  FILE_ATTRIBUTE_TAG_INFO before;
  FILE_ATTRIBUTE_TAG_INFO after;
  BY_HANDLE_FILE_INFORMATION before_identity;
  BY_HANDLE_FILE_INFORMATION after_identity;
  PTOKEN_USER token_user = NULL;
  BYTE system_sid[SECURITY_MAX_SID_SIZE];
  BYTE administrators_sid[SECURITY_MAX_SID_SIZE];
  DWORD system_size = sizeof(system_sid);
  DWORD administrators_size = sizeof(administrators_sid);
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PSID owner = NULL;
  PACL dacl = NULL;
  SECURITY_DESCRIPTOR_CONTROL control = 0U;
  DWORD revision = 0U;
  DWORD result;
  DWORD ace_index;
  BOOL found[3] = { FALSE, FALSE, FALSE };
  BOOL any_inherited = FALSE;
  BOOL success = FALSE;
  if (!cbd_open_leaf(path, directory, &leaf, &before, failure_code, error_code)) return FALSE;
  if (!GetFileInformationByHandle(leaf, &before_identity)) {
    *failure_code = "open_failed";
    *error_code = GetLastError();
    goto cleanup;
  }
  if (!cbd_get_current_user(&token_user, error_code)) {
    *failure_code = "open_failed";
    goto cleanup;
  }
  if (!cbd_create_required_sids(
        system_sid,
        &system_size,
        administrators_sid,
        &administrators_size,
        error_code)) {
    *failure_code = "open_failed";
    goto cleanup;
  }
  result = GetSecurityInfo(
    leaf,
    SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner,
    NULL,
    &dacl,
    NULL,
    &descriptor
  );
  if (result != ERROR_SUCCESS) {
    *error_code = result;
    *failure_code = cbd_path_error_code(result, "open_failed");
    goto cleanup;
  }
  if (owner == NULL || !EqualSid(owner, token_user->User.Sid)) {
    *failure_code = "owner_mismatch";
    *error_code = ERROR_SUCCESS;
    goto cleanup;
  }
  if (dacl == NULL || !IsValidAcl(dacl)) {
    *failure_code = "missing_required_ace";
    *error_code = ERROR_INVALID_ACL;
    goto cleanup;
  }
  if (!GetSecurityDescriptorControl(descriptor, &control, &revision)) {
    *failure_code = "open_failed";
    *error_code = GetLastError();
    goto cleanup;
  }
  for (ace_index = 0U; ace_index < dacl->AceCount; ace_index += 1U) {
    PVOID raw_ace = NULL;
    PACE_HEADER header;
    PACCESS_ALLOWED_ACE ace;
    PSID sid;
    DWORD sid_index;
    BYTE expected_flags;
    if (!GetAce(dacl, ace_index, &raw_ace)) {
      *failure_code = "open_failed";
      *error_code = GetLastError();
      goto cleanup;
    }
    header = (PACE_HEADER)raw_ace;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE
        || header->AceType == ACCESS_DENIED_OBJECT_ACE_TYPE
        || header->AceType == ACCESS_DENIED_CALLBACK_ACE_TYPE
        || header->AceType == ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE) {
      *failure_code = "deny_ace";
      *error_code = ERROR_SUCCESS;
      goto cleanup;
    }
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) {
      *failure_code = "wide_acl";
      *error_code = ERROR_SUCCESS;
      goto cleanup;
    }
    ace = (PACCESS_ALLOWED_ACE)raw_ace;
    sid = (PSID)&ace->SidStart;
    if (!IsValidSid(sid)
        || !cbd_sid_index(
          sid,
          token_user->User.Sid,
          system_sid,
          administrators_sid,
          &sid_index
        )
        || found[sid_index]) {
      *failure_code = "wide_acl";
      *error_code = ERROR_SUCCESS;
      goto cleanup;
    }
    expected_flags = directory
      ? (BYTE)(OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)
      : (BYTE)0U;
    if (ace->Mask != FILE_ALL_ACCESS || header->AceFlags != expected_flags) {
      *failure_code = "wide_acl";
      *error_code = ERROR_SUCCESS;
      goto cleanup;
    }
    if ((header->AceFlags & INHERITED_ACE) != 0U) any_inherited = TRUE;
    found[sid_index] = TRUE;
  }
  if (!found[0] || !found[1] || !found[2]) {
    *failure_code = "missing_required_ace";
    *error_code = ERROR_SUCCESS;
    goto cleanup;
  }
  /* Full leaf template: protected DACL with explicit (non-inherited) ACEs only.
     OI|CI on parents provides the other-user access boundary for hot-path
     children, but verify_private_* never accepts unprotected inherited children
     as a substitute for ensure_private_file (ADR 0002 Phase 1). */
  if ((control & SE_DACL_PROTECTED) == 0U) {
    *failure_code = "inheritance_enabled";
    *error_code = ERROR_SUCCESS;
    goto cleanup;
  }
  if (any_inherited) {
    *failure_code = "wide_acl";
    *error_code = ERROR_SUCCESS;
    goto cleanup;
  }
  if (!cbd_open_leaf(path, directory, &reopened, &after, failure_code, error_code)) {
    goto cleanup;
  }
  if (!GetFileInformationByHandle(reopened, &after_identity)) {
    *failure_code = "open_failed";
    *error_code = GetLastError();
    goto cleanup;
  }
  if (before.ReparseTag != after.ReparseTag
      || before.FileAttributes != after.FileAttributes
      || before_identity.dwVolumeSerialNumber != after_identity.dwVolumeSerialNumber
      || before_identity.nFileIndexHigh != after_identity.nFileIndexHigh
      || before_identity.nFileIndexLow != after_identity.nFileIndexLow) {
    *failure_code = "open_failed";
    *error_code = ERROR_FILE_INVALID;
    goto cleanup;
  }
  if (!ConvertSidToStringSidW(owner, owner_text)) {
    *failure_code = "open_failed";
    *error_code = GetLastError();
    goto cleanup;
  }
  success = TRUE;

cleanup:
  if (descriptor != NULL) LocalFree(descriptor);
  if (token_user != NULL) HeapFree(GetProcessHeap(), 0U, token_user);
  if (reopened != INVALID_HANDLE_VALUE) CloseHandle(reopened);
  if (leaf != INVALID_HANDLE_VALUE) CloseHandle(leaf);
  return success;
}

static int cbd_verify_and_emit(const wchar_t *op, const wchar_t *path, BOOL directory) {
  wchar_t *owner_text = NULL;
  const char *failure_code = "open_failed";
  DWORD error_code = ERROR_SUCCESS;
  if (!cbd_volume_supports_acls(path, &error_code)) {
    (void)cbd_emit_failure(
      op,
      path,
      "filesystem_acl_unavailable",
      L"Filesystem does not report persistent ACL support",
      error_code
    );
    return 1;
  }
  if (!cbd_verify_private_security(
        path,
        directory,
        &owner_text,
        &failure_code,
        &error_code)) {
    (void)cbd_emit_failure(op, path, failure_code, L"Private DACL verification failed", error_code);
    return 1;
  }
  (void)cbd_emit_owner_success(op, path, owner_text);
  LocalFree(owner_text);
  return 0;
}

static int cbd_ensure_and_emit(const wchar_t *op, const wchar_t *path, BOOL directory) {
  DWORD attributes;
  DWORD error_code = ERROR_SUCCESS;
  const char *failure_code = "open_failed";
  FILE_ATTRIBUTE_TAG_INFO tag;
  HANDLE leaf = INVALID_HANDLE_VALUE;
  if (cbd_is_unc_path(path)) {
    (void)cbd_emit_failure(
      op,
      path,
      "filesystem_acl_unavailable",
      L"UNC paths are unavailable for DACL ensure",
      ERROR_NOT_SUPPORTED
    );
    return 1;
  }
  if (!cbd_volume_supports_acls(path, &error_code)) {
    (void)cbd_emit_failure(
      op,
      path,
      "filesystem_acl_unavailable",
      L"Filesystem does not report persistent ACL support",
      error_code
    );
    return 1;
  }
  attributes = GetFileAttributesW(path);
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    error_code = GetLastError();
    if (error_code != ERROR_FILE_NOT_FOUND && error_code != ERROR_PATH_NOT_FOUND) {
      (void)cbd_emit_failure(
        op,
        path,
        cbd_path_error_code(error_code, "open_failed"),
        L"Path attributes could not be read",
        error_code
      );
      return 1;
    }
    if (!cbd_create_private_leaf(path, directory, &failure_code, &error_code)) {
      (void)cbd_emit_failure(op, path, failure_code, L"Private leaf creation failed", error_code);
      return 1;
    }
  }
  if (!cbd_open_leaf(path, directory, &leaf, &tag, &failure_code, &error_code)) {
    (void)cbd_emit_failure(op, path, failure_code, L"Created leaf validation failed", error_code);
    return 1;
  }
  CloseHandle(leaf);
  if (!cbd_set_private_security(path, directory, &error_code)) {
    (void)cbd_emit_failure(
      op,
      path,
      cbd_path_error_code(error_code, "set_security_failed"),
      L"Private owner and DACL assignment failed",
      error_code
    );
    return 1;
  }
  return cbd_verify_and_emit(op, path, directory);
}

static size_t cbd_root_length(const wchar_t *path) {
  return path[0] == L'\\' ? 7U : 3U;
}

static void cbd_strip_trailing_separators(wchar_t *path) {
  size_t length = wcslen(path);
  size_t root_length = cbd_root_length(path);
  while (length > root_length && (path[length - 1U] == L'\\' || path[length - 1U] == L'/')) {
    path[length - 1U] = L'\0';
    length -= 1U;
  }
}

static BOOL cbd_normalize_path(const wchar_t *path, wchar_t **normalized, DWORD *error_code) {
  wchar_t *buffer;
  DWORD length;
  buffer = (wchar_t *)HeapAlloc(
    GetProcessHeap(),
    HEAP_ZERO_MEMORY,
    (CBD_MAX_PATH_UNITS + 1U) * sizeof(wchar_t)
  );
  if (buffer == NULL) {
    *error_code = ERROR_NOT_ENOUGH_MEMORY;
    return FALSE;
  }
  length = GetFullPathNameW(path, CBD_MAX_PATH_UNITS + 1U, buffer, NULL);
  if (length == 0U || length > CBD_MAX_PATH_UNITS) {
    *error_code = length == 0U ? GetLastError() : ERROR_FILENAME_EXCED_RANGE;
    HeapFree(GetProcessHeap(), 0U, buffer);
    return FALSE;
  }
  cbd_strip_trailing_separators(buffer);
  *normalized = buffer;
  return TRUE;
}

static BOOL cbd_is_strict_descendant(const wchar_t *path, const wchar_t *anchor) {
  size_t anchor_length = wcslen(anchor);
  if (wcslen(path) <= anchor_length || _wcsnicmp(path, anchor, anchor_length) != 0) return FALSE;
  if (anchor[anchor_length - 1U] == L'\\' || anchor[anchor_length - 1U] == L'/') return TRUE;
  return path[anchor_length] == L'\\' || path[anchor_length] == L'/';
}

static BOOL cbd_remove_last_component(wchar_t *path) {
  size_t length = wcslen(path);
  size_t root_length = cbd_root_length(path);
  while (length > root_length) {
    length -= 1U;
    if (path[length] == L'\\' || path[length] == L'/') {
      if (length < root_length) return FALSE;
      path[length] = L'\0';
      cbd_strip_trailing_separators(path);
      return TRUE;
    }
  }
  return FALSE;
}

static int cbd_verify_tree_and_emit(
    const wchar_t *op,
    const wchar_t *path,
    const wchar_t *anchor) {
  wchar_t *normalized_path = NULL;
  wchar_t *normalized_anchor = NULL;
  wchar_t *owner_text = NULL;
  const char *failure_code = "open_failed";
  DWORD error_code = ERROR_SUCCESS;
  HANDLE ancestor = INVALID_HANDLE_VALUE;
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (!cbd_volume_supports_acls(path, &error_code)) {
    (void)cbd_emit_failure(
      op,
      path,
      "filesystem_acl_unavailable",
      L"Filesystem does not report persistent ACL support",
      error_code
    );
    return 1;
  }
  if (!cbd_normalize_path(path, &normalized_path, &error_code)
      || !cbd_normalize_path(anchor, &normalized_anchor, &error_code)) {
    (void)cbd_emit_failure(op, path, "path_too_long", L"Path normalization failed", error_code);
    goto failure;
  }
  if (!cbd_is_strict_descendant(normalized_path, normalized_anchor)) {
    (void)cbd_emit_failure(
      op,
      path,
      "ancestor_escape",
      L"Path is not beneath the ancestor anchor",
      ERROR_INVALID_PARAMETER
    );
    goto failure;
  }
  if (!cbd_verify_private_security(
        normalized_path,
        TRUE,
        &owner_text,
        &failure_code,
        &error_code)) {
    (void)cbd_emit_failure(op, path, failure_code, L"Private tree leaf verification failed", error_code);
    goto failure;
  }
  while (cbd_remove_last_component(normalized_path)) {
    if (_wcsicmp(normalized_path, normalized_anchor) == 0) break;
    if (!cbd_open_leaf(
          normalized_path,
          TRUE,
          &ancestor,
          &tag,
          &failure_code,
          &error_code)) {
      if (strcmp(failure_code, "reparse_point") == 0) failure_code = "ancestor_reparse";
      (void)cbd_emit_failure(op, path, failure_code, L"Ancestor validation failed", error_code);
      goto failure;
    }
    CloseHandle(ancestor);
    ancestor = INVALID_HANDLE_VALUE;
  }
  (void)cbd_emit_owner_success(op, path, owner_text);
  LocalFree(owner_text);
  HeapFree(GetProcessHeap(), 0U, normalized_path);
  HeapFree(GetProcessHeap(), 0U, normalized_anchor);
  return 0;

failure:
  if (ancestor != INVALID_HANDLE_VALUE) CloseHandle(ancestor);
  if (owner_text != NULL) LocalFree(owner_text);
  if (normalized_path != NULL) HeapFree(GetProcessHeap(), 0U, normalized_path);
  if (normalized_anchor != NULL) HeapFree(GetProcessHeap(), 0U, normalized_anchor);
  return 1;
}

static int cbd_main(int argc, wchar_t **argv) {
  const wchar_t *op = argc > 4 ? argv[4] : L"unknown";
  const wchar_t *path = NULL;
  const wchar_t *anchor = NULL;
  int index;
  if (argc < 5 || wcscmp(argv[3], L"dacl") != 0) {
    (void)cbd_emit_failure(op, NULL, "invalid_arguments", L"Invalid DACL protocol arguments", 0U);
    return 125;
  }
  if (wcscmp(op, L"protocol_info") == 0) {
    if (argc != 5) {
      (void)cbd_emit_failure(op, NULL, "invalid_arguments", L"protocol_info takes no path", 0U);
      return 125;
    }
    (void)cbd_emit_protocol_info(op);
    return 0;
  }
  for (index = 5; index < argc; index += 2) {
    if (index + 1 >= argc) {
      (void)cbd_emit_failure(op, path, "invalid_arguments", L"Missing DACL argument value", 0U);
      return 125;
    }
    if (wcscmp(argv[index], L"--path") == 0 && path == NULL) path = argv[index + 1];
    else if (wcscmp(argv[index], L"--ancestors-until") == 0 && anchor == NULL) {
      anchor = argv[index + 1];
    } else {
      (void)cbd_emit_failure(op, path, "invalid_arguments", L"Unknown or duplicate DACL argument", 0U);
      return 125;
    }
  }
  if (path == NULL || path[0] == L'\0') {
    (void)cbd_emit_failure(op, path, "invalid_arguments", L"DACL path is required", 0U);
    return 125;
  }
  if (!cbd_path_length_valid(path) || (anchor != NULL && !cbd_path_length_valid(anchor))) {
    (void)cbd_emit_failure(op, path, "path_too_long", L"DACL path exceeds 32766 UTF-16 units", 0U);
    return 125;
  }
  if ((!cbd_is_absolute_drive_path(path) && !cbd_is_unc_path(path))
      || (anchor != NULL && !cbd_is_absolute_drive_path(anchor) && !cbd_is_unc_path(anchor))) {
    (void)cbd_emit_failure(op, path, "path_not_absolute", L"DACL paths must be drive-qualified or UNC", 0U);
    return 125;
  }
  /* Ensure rejects UNC inside cbd_ensure_and_emit; verify may probe capability. */
  if (wcscmp(op, L"ensure_private_dir") == 0 && anchor == NULL) {
    return cbd_ensure_and_emit(op, path, TRUE);
  }
  if (wcscmp(op, L"ensure_private_file") == 0 && anchor == NULL) {
    return cbd_ensure_and_emit(op, path, FALSE);
  }
  if (wcscmp(op, L"verify_private_dir") == 0 && anchor == NULL) {
    return cbd_verify_and_emit(op, path, TRUE);
  }
  if (wcscmp(op, L"verify_private_file") == 0 && anchor == NULL) {
    return cbd_verify_and_emit(op, path, FALSE);
  }
  if (wcscmp(op, L"verify_private_tree") == 0 && anchor != NULL) {
    return cbd_verify_tree_and_emit(op, path, anchor);
  }
  if (wcscmp(op, L"filesystem_acl_capable") == 0 && anchor == NULL) {
    DWORD error_code = ERROR_SUCCESS;
    if (!cbd_volume_supports_acls(path, &error_code)) {
      (void)cbd_emit_failure(
        op,
        path,
        "filesystem_acl_unavailable",
        L"Filesystem does not report persistent ACL support",
        error_code
      );
      return 1;
    }
    (void)cbd_emit_filesystem_success(op, path);
    return 0;
  }
  (void)cbd_emit_failure(op, path, "invalid_arguments", L"Unsupported DACL operation arguments", 0U);
  return 125;
}

int wmain(int argc, wchar_t **argv) {
  const int first_provider_arg = 10;
  const wchar_t *pipe_name;
  const wchar_t *token_wide;
  char token[65];
  DWORD timeout_ms = 0U;
  DWORD error_code = ERROR_INVALID_PARAMETER;
  DWORD provider_exit_code = 0U;
  DWORD wait_result;
  int result_code = 125;
  HANDLE control = INVALID_HANDLE_VALUE;
  HANDLE job = NULL;
  HANDLE timer = NULL;
  HANDLE monitor_thread = NULL;
  HANDLE child_stdin = NULL;
  HANDLE child_stdout = NULL;
  HANDLE child_stderr = NULL;
  HANDLE inherited_handles[3];
  HANDLE wait_handles[3];
  SIZE_T attribute_bytes = 0U;
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
  wchar_t *command_line = NULL;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  STARTUPINFOEXW startup;
  PROCESS_INFORMATION provider;
  LARGE_INTEGER due_time;
  cbj_monitor_context monitor;
  cbj_cancel_reason termination_reason = CBJ_CANCEL_NONE;
  BOOL provider_created = FALSE;
  BOOL provider_assigned = FALSE;
  BOOL attributes_initialized = FALSE;
  BOOL terminal_written = FALSE;
  char hello[96];
  char start_line[CBJ_MAX_CONTROL_LINE];

  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&provider, sizeof(provider));
  ZeroMemory(&monitor, sizeof(monitor));
  ZeroMemory(&limits, sizeof(limits));

  if (argc >= 4
      && wcscmp(argv[1], L"--protocol") == 0
      && wcscmp(argv[3], L"dacl") == 0
      && wcscmp(argv[2], CBD_PROTOCOL_W) != 0) {
    const wchar_t *op = argc > 4 ? argv[4] : L"unknown";
    (void)cbd_emit_failure(
      op,
      NULL,
      "protocol_mismatch",
      L"DACL protocol 2 is required",
      ERROR_REVISION_MISMATCH
    );
    return 1;
  }
  if (argc >= 3
      && wcscmp(argv[1], L"--protocol") == 0
      && wcscmp(argv[2], CBD_PROTOCOL_W) == 0) {
    return cbd_main(argc, argv);
  }

  if (argc < 11
      || wcscmp(argv[1], L"--protocol") != 0
      || wcscmp(argv[2], CBJ_PROTOCOL_W) != 0
      || wcscmp(argv[3], L"--control") != 0
      || wcscmp(argv[5], L"--token") != 0
      || wcscmp(argv[7], L"--timeout-ms") != 0
      || wcscmp(argv[9], L"--") != 0
      || argv[10][0] == L'\0'
      || !cbj_is_absolute_application_path(argv[10])
      || !cbj_is_hex_token(argv[6])
      || !cbj_parse_timeout(argv[8], &timeout_ms)) {
    return 125;
  }
  pipe_name = argv[4];
  token_wide = argv[6];
  if (wcsncmp(pipe_name, L"\\\\.\\pipe\\", 9U) != 0
      || wcslen(pipe_name) > 240U
      || !cbj_ascii_from_wide(token_wide, token, sizeof(token))) return 125;

  control = cbj_connect_control(pipe_name, &error_code);
  if (control == INVALID_HANDLE_VALUE) return 125;
  if (_snprintf_s(hello, sizeof(hello), _TRUNCATE, "HELLO %s", token) < 0
      || !cbj_write_record(control, hello)) goto cleanup;
  if (cbj_read_line(control, start_line, (DWORD)sizeof(start_line)) != 1
      || strcmp(start_line, "CBJ " CBJ_PROTOCOL_A " START") != 0) {
    (void)cbj_write_error(control, "control_protocol", ERROR_INVALID_DATA);
    terminal_written = TRUE;
    goto cleanup;
  }

  command_line = cbj_build_command_line(argc, argv, first_provider_arg);
  if (command_line == NULL) {
    (void)cbj_write_error(control, "arguments", GetLastError());
    terminal_written = TRUE;
    goto cleanup;
  }

  job = CreateJobObjectW(NULL, NULL);
  if (job == NULL) {
    (void)cbj_write_error(control, "create_job", GetLastError());
    terminal_written = TRUE;
    goto cleanup;
  }
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &limits,
        (DWORD)sizeof(limits))) {
    (void)cbj_write_error(control, "configure_job", GetLastError());
    terminal_written = TRUE;
    goto cleanup;
  }

  timer = CreateWaitableTimerW(NULL, TRUE, NULL);
  if (timer == NULL) {
    (void)cbj_write_error(control, "create_timer", GetLastError());
    terminal_written = TRUE;
    goto cleanup;
  }
  due_time.QuadPart = -((LONGLONG)timeout_ms * 10000LL);
  if (!SetWaitableTimer(timer, &due_time, 0L, NULL, NULL, FALSE)) {
    (void)cbj_write_error(control, "create_timer", GetLastError());
    terminal_written = TRUE;
    goto cleanup;
  }

  if (!cbj_duplicate_inheritable(GetStdHandle(STD_INPUT_HANDLE), &child_stdin)
      || !cbj_duplicate_inheritable(GetStdHandle(STD_OUTPUT_HANDLE), &child_stdout)
      || !cbj_duplicate_inheritable(GetStdHandle(STD_ERROR_HANDLE), &child_stderr)) {
    (void)cbj_write_error(control, "create_process", GetLastError());
    terminal_written = TRUE;
    goto cleanup;
  }
  inherited_handles[0] = child_stdin;
  inherited_handles[1] = child_stdout;
  inherited_handles[2] = child_stderr;

  (void)InitializeProcThreadAttributeList(NULL, 1U, 0U, &attribute_bytes);
  if (attribute_bytes == 0U) {
    (void)cbj_write_error(control, "create_process", GetLastError());
    terminal_written = TRUE;
    goto cleanup;
  }
  attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(
    GetProcessHeap(),
    HEAP_ZERO_MEMORY,
    attribute_bytes
  );
  if (attributes == NULL) {
    error_code = ERROR_NOT_ENOUGH_MEMORY;
    (void)cbj_write_error(control, "create_process", error_code);
    terminal_written = TRUE;
    goto cleanup;
  }
  if (!InitializeProcThreadAttributeList(attributes, 1U, 0U, &attribute_bytes)) {
    error_code = GetLastError();
    (void)cbj_write_error(control, "create_process", error_code);
    terminal_written = TRUE;
    goto cleanup;
  }
  attributes_initialized = TRUE;
  if (!UpdateProcThreadAttribute(
        attributes,
        0U,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        inherited_handles,
        sizeof(inherited_handles),
        NULL,
        NULL)) {
    error_code = GetLastError();
    (void)cbj_write_error(control, "create_process", error_code);
    terminal_written = TRUE;
    goto cleanup;
  }

  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = child_stdin;
  startup.StartupInfo.hStdOutput = child_stdout;
  startup.StartupInfo.hStdError = child_stderr;
  startup.lpAttributeList = attributes;

  if (!CreateProcessW(
        argv[10],
        command_line,
        NULL,
        NULL,
        TRUE,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        NULL,
        NULL,
        &startup.StartupInfo,
        &provider)) {
    (void)cbj_write_error(control, "create_process", GetLastError());
    terminal_written = TRUE;
    goto cleanup;
  }
  provider_created = TRUE;

  if (!AssignProcessToJobObject(job, provider.hProcess)) {
    error_code = GetLastError();
    (void)TerminateProcess(provider.hProcess, 125U);
    (void)WaitForSingleObject(provider.hProcess, CBJ_JOB_DRAIN_MS);
    (void)cbj_write_error(control, "assign_job", error_code);
    terminal_written = TRUE;
    goto cleanup;
  }
  provider_assigned = TRUE;

  monitor.control = control;
  monitor.cancelled = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (monitor.cancelled == NULL) {
    (void)cbj_write_error(control, "create_monitor", GetLastError());
    terminal_written = TRUE;
    goto cleanup;
  }
  monitor_thread = CreateThread(NULL, 0U, cbj_monitor_parent, &monitor, 0U, NULL);
  if (monitor_thread == NULL) {
    (void)cbj_write_error(control, "create_monitor", GetLastError());
    terminal_written = TRUE;
    goto cleanup;
  }

  if (!cbj_write_ready(control, provider.dwProcessId)) {
    termination_reason = CBJ_CANCEL_PARENT_DEATH;
    goto terminate;
  }
  if (WaitForSingleObject(monitor.cancelled, 0U) == WAIT_OBJECT_0) {
    termination_reason = (cbj_cancel_reason)InterlockedCompareExchange(&monitor.reason, 0L, 0L);
    goto terminate;
  }
  if (WaitForSingleObject(timer, 0U) == WAIT_OBJECT_0) {
    termination_reason = CBJ_CANCEL_TIMEOUT;
    goto terminate;
  }
  if (ResumeThread(provider.hThread) == (DWORD)-1) {
    error_code = GetLastError();
    (void)cbj_write_error(control, "resume_process", error_code);
    terminal_written = TRUE;
    goto cleanup;
  }

  wait_handles[0] = provider.hProcess;
  wait_handles[1] = monitor.cancelled;
  wait_handles[2] = timer;
  wait_result = WaitForMultipleObjects(3U, wait_handles, FALSE, INFINITE);
  if (wait_result == WAIT_OBJECT_0) {
    if (!GetExitCodeProcess(provider.hProcess, &provider_exit_code)) {
      (void)cbj_write_error(control, "query_exit", GetLastError());
      terminal_written = TRUE;
      goto cleanup;
    }
    if (!cbj_terminate_and_drain_job(job, 125U, &error_code)) {
      (void)cbj_write_error(
        control,
        error_code == WAIT_TIMEOUT ? "cleanup_job" : "terminate_job",
        error_code
      );
      terminal_written = TRUE;
      goto cleanup;
    }
    if (!cbj_write_exit(control, provider_exit_code)) goto cleanup;
    terminal_written = TRUE;
    result_code = (int)provider_exit_code;
    goto cleanup;
  }
  if (wait_result == WAIT_OBJECT_0 + 1U) {
    termination_reason = (cbj_cancel_reason)InterlockedCompareExchange(&monitor.reason, 0L, 0L);
    goto terminate;
  }
  if (wait_result == WAIT_OBJECT_0 + 2U) {
    termination_reason = CBJ_CANCEL_TIMEOUT;
    goto terminate;
  }
  (void)cbj_write_error(control, "wait_process", GetLastError());
  terminal_written = TRUE;
  goto cleanup;

terminate:
  if (termination_reason == CBJ_CANCEL_NONE) termination_reason = CBJ_CANCEL_PROTOCOL;
  if (!cbj_terminate_and_drain_job(job, 124U, &error_code)) {
    (void)cbj_write_error(
      control,
      error_code == WAIT_TIMEOUT ? "cleanup_job" : "terminate_job",
      error_code
    );
    /* ERROR control records must exit 125 so the Node validator surfaces the
       stage/Win32 error instead of a control_protocol mismatch. */
    result_code = 125;
  } else {
    (void)cbj_write_terminated(control, termination_reason);
    result_code = 124;
  }
  terminal_written = TRUE;

cleanup:
  if (provider_assigned && !terminal_written) {
    (void)cbj_terminate_and_drain_job(job, 125U, &error_code);
  } else if (provider_created && !provider_assigned) {
    (void)TerminateProcess(provider.hProcess, 125U);
    (void)WaitForSingleObject(provider.hProcess, CBJ_JOB_DRAIN_MS);
  }
  InterlockedExchange(&monitor.shutting_down, 1L);
  if (control != INVALID_HANDLE_VALUE) (void)CancelIoEx(control, NULL);
  if (monitor_thread != NULL) {
    (void)WaitForSingleObject(monitor_thread, INFINITE);
    CloseHandle(monitor_thread);
  }
  if (monitor.cancelled != NULL) CloseHandle(monitor.cancelled);
  if (provider.hThread != NULL) CloseHandle(provider.hThread);
  if (provider.hProcess != NULL) CloseHandle(provider.hProcess);
  if (child_stdin != NULL) CloseHandle(child_stdin);
  if (child_stdout != NULL) CloseHandle(child_stdout);
  if (child_stderr != NULL) CloseHandle(child_stderr);
  if (attributes != NULL) {
    if (attributes_initialized) DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0U, attributes);
  }
  if (command_line != NULL) HeapFree(GetProcessHeap(), 0U, command_line);
  if (timer != NULL) CloseHandle(timer);
  if (job != NULL) CloseHandle(job);
  if (control != INVALID_HANDLE_VALUE) CloseHandle(control);
  return result_code;
}
