import express = require("express");
import bodyParser = require('body-parser');

export enum Method {
    GET,
    POST,
    PUT
}

export interface Request
       extends express.Request,
               bodyParser.ParsedAsJson,
               bodyParser.ParsedAsUrlencoded {
}

export interface Explainable {
    explain(): string;
}
