from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(Exception):
    """An error the client can act on. Rendered as {"error": {"code", "message", "details"}}."""

    def __init__(self, status: int, code: str, message: str, details: object = None, headers: dict | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.details, self.headers = status, code, message, details, headers


def bad_request(code: str, message: str, details: object = None) -> ApiError:
    return ApiError(400, code, message, details)


def not_found(what: str) -> ApiError:
    return ApiError(404, "not_found", f"{what} not found")


def conflict(code: str, message: str, details: object = None) -> ApiError:
    return ApiError(409, code, message, details)


def _body(code: str, message: str, details: object = None) -> dict:
    return {"error": {"code": code, "message": message, "details": details}}


def install(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api(_: Request, e: ApiError):
        return JSONResponse(_body(e.code, e.message, e.details), status_code=e.status, headers=e.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, e: RequestValidationError):
        fields = [{"field": ".".join(str(p) for p in err["loc"][1:]), "message": err["msg"]} for err in e.errors()]
        return JSONResponse(_body("validation_error", "The request is not valid", fields), status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, e: StarletteHTTPException):
        return JSONResponse(_body("http_error", str(e.detail)), status_code=e.status_code)
