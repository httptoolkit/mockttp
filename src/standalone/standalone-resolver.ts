export function getResolver() {
    return {
        mockedEndpoints: () => [{ id: 1, seenRequests: [{ id: 5, body: 'hi!' }] }],
        reset: () => console.log('Reset!')
    };
}