#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <stdio.h>

int wmain(int argc, wchar_t **argv) {
  STARTUPINFOW startup;
  PROCESS_INFORMATION child;
  DWORD error_code;
  if (argc != 2 || argv[1][0] == L'\0') return 3;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&child, sizeof(child));
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  if (CreateProcessW(
        argv[1],
        NULL,
        NULL,
        NULL,
        FALSE,
        CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED,
        NULL,
        NULL,
        &startup,
        &child)) {
    (void)TerminateProcess(child.hProcess, 99U);
    (void)WaitForSingleObject(child.hProcess, 2000U);
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
    return 99;
  }
  error_code = GetLastError();
  if (error_code != ERROR_ACCESS_DENIED) {
    fprintf(stderr, "unexpected breakaway error %lu", error_code);
    return 2;
  }
  fputs("breakaway_denied", stdout);
  return 0;
}
