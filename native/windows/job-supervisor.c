#define _WIN32_WINNT 0x0602
#include <windows.h>

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
  } else {
    (void)cbj_write_terminated(control, termination_reason);
  }
  terminal_written = TRUE;
  result_code = 124;

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
