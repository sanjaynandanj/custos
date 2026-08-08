from custos.canonical import dumps, loads


def test_key_sort_deep():
    v = {"b": 1, "a": {"z": 2, "y": 3}}
    assert dumps(v) == b'{"a":{"y":3,"z":2},"b":1}'


def test_no_whitespace():
    assert dumps([1, 2, 3]) == b"[1,2,3]"


def test_utf8_preserved():
    assert dumps({"k": "é"}) == '{"k":"é"}'.encode("utf-8")


def test_roundtrip():
    v = {"x": [1, {"a": None, "b": True}], "y": 3.14}
    assert loads(dumps(v)) == v
