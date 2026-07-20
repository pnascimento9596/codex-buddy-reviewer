#define _WIN32_WINNT 0x0602
#include <windows.h>

#include <stdio.h>
#include <wchar.h>

int wmain(int argc, wchar_t **argv) {
#ifdef CBR_DECOY
  static const char marker[] = "decoy";
  HANDLE file;
  DWORD written = 0U;
  if (argc != 2) return 92;
  file = CreateFileW(
    argv[1],
    GENERIC_WRITE,
    0U,
    NULL,
    CREATE_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    NULL
  );
  if (file == INVALID_HANDLE_VALUE) return 93;
  if (!WriteFile(file, marker, (DWORD)(sizeof(marker) - 1U), &written, NULL)
      || written != sizeof(marker) - 1U) {
    CloseHandle(file);
    return 94;
  }
  CloseHandle(file);
  fputs("decoy", stdout);
  return 91;
#else
  (void)argc;
  (void)argv;
  fputs("trusted", stdout);
  return 0;
#endif
}
